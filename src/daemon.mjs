import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Controller } from './controller.mjs';
import { Store, stateDirectory, pipeName, loadToken, atomicWrite } from './store.mjs';
import { Peer } from './rpc.mjs';
import { installation, ROOT } from './client.mjs';

function validToken(candidate, actual) {
  return typeof candidate === 'string' && candidate.length === actual.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(actual));
}

export async function runDaemon({ home = stateDirectory() } = {}) {
  const token = loadToken(home);
  // Bind before opening the state store: only one process may own or recover it.
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipeName(home), resolve); });
  if (process.platform !== 'win32') fs.chmodSync(pipeName(home), 0o600);
  let store;
  try { store = new Store(home); } catch (error) { server.close(); throw error; }
  const peers = new Set(); let power = null; let timer; let checking = null; let stopped = false;
  const config = installation();
  const nativePath = config.nativePath || path.join(ROOT, 'dist', 'codex-quota-bridge.exe');
  const controller = new Controller(store, { onChange: status => {
    const hold = status.enabled && status.config.preventSleep && status.pendingCount > 0;
    if (hold && !power && process.platform === 'win32' && fs.existsSync(nativePath)) {
      const powerProcess = power = spawn(nativePath, ['--power'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      powerProcess.on('error', () => { if (power === powerProcess) power = null; });
      powerProcess.on('exit', () => { if (power === powerProcess) power = null; });
    } else if (!hold && power) { const old = power; power = null; old.stdin.end(); }
    atomicWrite(path.join(home, 'status.json'), status);
  } });
  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    const now = Date.now();
    const next = Math.min(now + controller.config.pollMs, ...[...controller.quotas.values()].map(q => q.nextCheckAt));
    timer = setTimeout(() => check().catch(() => {}), Math.max(250, next - now));
  }
  async function check() {
    if (stopped) return;
    if (checking) return checking;
    checking = controller.tick().finally(() => { checking = null; schedule(); });
    return checking;
  }
  function makeAdapter(peer, meta) {
    return { ready: false, accountId: null, engineKey: meta.engineKey || 'local',
      call: (method, params, timeout) => peer.call('engine.call', { method, params }, timeout ?? 30_000),
      listActive: () => peer.call('engine.active', {}, 60_000),
      inspect: threadId => peer.call('engine.inspect', { threadId }),
      hasLoaded: threadId => peer.call('engine.loaded', { threadId }),
      ensureLoaded: threadId => peer.call('engine.load', { threadId }),
    };
  }
  server.on('connection', socket => {
    const peer = new Peer(socket); peers.add(peer);
    let role = null; let id = null; let adapter = null;
    const timeout = setTimeout(() => socket.destroy(), 5000);
    peer.on('message', async request => {
      if (!request.method) return;
      try {
        if (request.method === 'hello') {
          if (role || !validToken(request.params?.token, token) || !['client', 'bridge'].includes(request.params?.role)) throw new Error('Unauthorized');
          role = request.params.role; clearTimeout(timeout);
          if (role === 'bridge') {
            id = randomUUID(); adapter = makeAdapter(peer, request.params); controller.addAdapter(id, adapter);
          }
          peer.reply(request, { ok: true }); return;
        }
        if (!role) throw new Error('Unauthorized');
        let result;
        switch (request.method) {
          case 'status': result = controller.status(); break;
          case 'configure': result = controller.configure(request.params || {}); await check(); break;
          case 'enable': controller.configure({ enabled: true }); await check(); result = controller.status(); break;
          case 'disable': result = controller.configure({ enabled: false }); break;
          case 'check': await check(); result = controller.status(); break;
          case 'cancel': result = controller.cancel(request.params?.id); break;
          case 'shutdown':
            result = { ok: true }; peer.reply(request, result); setTimeout(shutdown, 50); return;
          default: {
            if (role !== 'bridge') throw new Error('Unknown command');
            if (request.method === 'bridge.ready') { adapter.ready = true; await check(); result = { ok: true }; }
            else if (request.method === 'bridge.accountChanged') { controller.invalidateAdapter(adapter); await check(); result = { ok: true }; }
            else if (request.method === 'bridge.changed') { check().catch(() => {}); result = { ok: true }; }
            else if (request.method === 'bridge.cancel') { controller.cancelThread(request.params.threadId, adapter.accountId); result = { ok: true }; }
            else if (request.method === 'bridge.gate') {
              if (!adapter.accountId || controller.policy(adapter.accountId).state === 'unknown') await check();
              if (!adapter.accountId) await check();
              const policy = controller.policy(adapter.accountId);
              const p = request.params.message.params;
              const done = p?.clientUserMessageId && store.data.jobs.find(j => j.accountId === adapter.accountId && j.threadId === p.threadId && j.key === p.clientUserMessageId && j.state === 'done');
              if (done) result = { allowed: false, completed: true, result: done.result };
              else if (['running', 'disabled'].includes(policy.state)) result = { allowed: true };
              else {
                const job = controller.capture(adapter, request.params.message);
                result = { allowed: false, jobId: job.id, reason: policy.reason };
              }
            } else throw new Error('Unknown bridge command');
          }
        }
        peer.reply(request, result);
      } catch (error) { try { peer.reject(request, error); } catch {} }
    });
    peer.on('disconnect', () => { clearTimeout(timeout); peers.delete(peer); if (id) controller.removeAdapter(id); schedule(); });
  });
  async function shutdown() {
    stopped = true;
    clearTimeout(timer); if (power) { power.stdin.end(); power = null; }
    for (const peer of peers) peer.output.destroy();
    await checking?.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    if (process.platform !== 'win32') try { fs.unlinkSync(pipeName(home)); } catch {}
  }
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  controller.changed(); schedule();
  if (config.trayEnabled && fs.existsSync(nativePath) && process.platform === 'win32') {
    const tray = spawn(nativePath, ['--tray'], { detached: true, windowsHide: true, stdio: 'ignore' });
    tray.on('error', () => {}); tray.unref();
  }
  return { server, controller, shutdown };
}
