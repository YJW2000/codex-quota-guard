import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Peer } from './rpc.mjs';
import { connectControl, installation } from './client.mjs';
import { MODEL_ACTIONS } from './controller.mjs';

export async function runBridge(args, { input = process.stdin, output = process.stdout, backendPath, backendArgs = [], home, test = false } = {}) {
  const config = installation(); backendPath ||= config.backendPath;
  if (!backendPath) throw new Error('未安装桥接程序；请先运行 install.ps1');
  if (!test && !config.testedEngineVersion) throw new Error('Codex 引擎版本尚未验证，拒绝启用桥接');
  if (!test) {
    const version = execFileSync(backendPath, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 }).trim();
    if (version !== config.testedEngineVersion) throw new Error('Codex 引擎已更新；请重新运行安装脚本完成兼容检查');
  }
  const child = spawn(backendPath, [...backendArgs, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_APP_RUNTIME_CLI_PATH: backendPath, ...(home ? { CODEX_QUOTA_GUARD_HOME: home } : {}) } });
  child.stderr.pipe(process.stderr);
  const engine = new Peer(child.stdout, child.stdin);
  const app = new Peer(input, output);
  const approval = new Map();
  let ready = false; let closing = false; let controlPromise;
  const engineKey = process.env.CODEX_QUOTA_GUARD_ENGINE_ID || createHash('sha256').update(process.env.CODEX_HOME || 'default').digest('hex').slice(0, 16);
  async function inspect(threadId) {
    const { thread } = await engine.call('thread/read', { threadId, includeTurns: false });
    const { data } = await engine.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    return { archived: thread.archived === true, active: thread.status?.type === 'active',
      approvalWaiting: thread.status?.activeFlags?.includes('waitingOnApproval') || [...approval.values()].includes(threadId),
      latestTurn: data?.[0] ?? null, child: typeof thread.source === 'object' && Boolean(thread.source?.subAgent) };
  }
  async function active() {
    const { data } = await engine.call('thread/loaded/list');
    const threads = await Promise.all((data || []).map(async threadId => {
      const info = await inspect(threadId);
      return info.active && info.latestTurn?.status === 'inProgress' ? { id: threadId, turnId: info.latestTurn.id, approvalWaiting: info.approvalWaiting, child: info.child } : null;
    }));
    return threads.filter(Boolean);
  }
  async function connect() {
    const peer = await connectControl({ role: 'bridge', home, metadata: { engineKey } });
    peer.on('message', async request => {
      try {
        let result;
        if (request.method === 'engine.call') {
          const { method, params } = request.params;
          const allowed = new Set(['account/rateLimits/read', 'turn/interrupt', 'turn/start', 'thread/queue/start', 'thread/compact/start', 'review/start']);
          if (!allowed.has(method)) throw new Error('Unsupported control method');
          result = await engine.call(method, params, 30_000);
        } else if (request.method === 'engine.active') result = await active();
        else if (request.method === 'engine.loaded') result = (await engine.call('thread/loaded/list')).data?.includes(request.params.threadId) ?? false;
        else if (request.method === 'engine.inspect') result = await inspect(request.params.threadId);
        else if (request.method === 'engine.load') {
          result = await engine.call('thread/resume', { threadId: request.params.threadId, excludeTurns: true });
        } else throw new Error('Unsupported bridge method');
        peer.reply(request, result);
      } catch (error) { try { peer.reject(request, error); } catch {} }
    });
    peer.on('disconnect', () => { controlPromise = null; });
    if (ready) await peer.call('bridge.ready', {}, 120_000);
    return peer;
  }
  const control = async () => controlPromise ||= connect().catch(error => { controlPromise = null; throw error; });
  async function notify(method, params = {}) {
    if (closing) return;
    try { await (await control()).call(method, params, 120_000); }
    catch (error) { process.stderr.write(`[quota-guard] ${error.message}\n`); }
  }
  engine.on('message', message => {
    if (message.method && message.id !== undefined && /requestApproval|requestUserInput|elicitation/.test(message.method)) approval.set(message.id, message.params?.threadId);
    if (message.method === 'account/updated') notify('bridge.accountChanged');
    else if (message.method === 'account/rateLimits/updated' || message.method === 'turn/completed') notify('bridge.changed');
    // A guard request's responses are consumed by Peer; only app messages reach here.
    app.send(message);
  });
  app.on('message', async message => {
    try {
      if (!message.method) { approval.delete(message.id); engine.send(message); return; }
      if (message.method === 'initialized') {
        engine.send(message); ready = true; await notify('bridge.ready'); return;
      }
      if (['turn/interrupt', 'thread/archive', 'thread/delete', 'thread/revert'].includes(message.method) && message.params?.threadId) {
        await notify('bridge.cancel', { threadId: message.params.threadId });
      }
      if (message.method === 'thread/queue/delete') {
        // The native queue is authoritative; a failed queued replay is never converted into a new input.
        await notify('bridge.cancel', { threadId: message.params?.threadId });
      }
      if (MODEL_ACTIONS.has(message.method)) {
        const peer = await control();
        const verdict = await peer.call('bridge.gate', { message }, 120_000);
        if (verdict.completed) { app.reply(message, verdict.result); return; }
        if (!verdict.allowed) {
          app.reject(message, Object.assign(new Error(`额度守卫已排队保存此任务：${verdict.reason}。恢复后将在原聊天执行；可在托盘取消。`), {
            code: -32003, data: { type: 'quota_guard_paused', jobId: verdict.jobId },
          })); return;
        }
      }
      // Preserve unknown fields and the desktop protocol verbatim.
      engine.send(message);
    } catch (error) { try { app.reject(message, error); } catch {} }
  });
  const watchdog = setInterval(() => { if (ready && !controlPromise && !closing) notify('bridge.ready'); }, 2000);
  watchdog.unref();
  function close() { if (closing) return; closing = true; clearInterval(watchdog); child.stdin.end(); controlPromise?.then(p => p.output.end()).catch(() => {}); }
  app.on('disconnect', close);
  child.on('error', error => { process.stderr.write(`[quota-guard] ${error.message}\n`); close(); });
  child.on('exit', () => { engine.fail(new Error('Engine exited')); close(); input.destroy(); output.end(); });
  return { engine, app, child, close };
}
