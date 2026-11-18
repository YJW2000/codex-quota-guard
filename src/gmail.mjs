import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Peer} from './rpc.mjs';
import {atomicWrite} from './store.mjs';

const server = 'codex_apps';
const profileTool = 'gmail.get_profile';
const sendTool = 'gmail.send_email';

// A transient app-server thread provides the user's existing connector permissions.
// Tool calls go directly to the connector and never start a model turn.
async function withGmail(backendPath, operation) {
  if (!backendPath || !fs.existsSync(backendPath)) throw Error('原版 CLI 不可用');
  const env = {...process.env};
  delete env.CODEX_CLI_PATH;
  delete env.CODEX_APP_RUNTIME_CLI_PATH;
  const child = spawn(backendPath, ['app-server'], {windowsHide:true, stdio:['pipe','pipe','ignore'], env});
  const peer = new Peer(child.stdout, child.stdin);
  child.on('error', error => peer.fail(error));
  peer.on('message', request => {
    if (!peer.closed && request.method && request.id != null) peer.reject(request, Error('发信后台不处理交互式授权'));
  });
  try {
    await peer.call('initialize', {clientInfo:{name:'codex_quota_notifications',version:'0.4.0'}, capabilities:{experimentalApi:true}});
    peer.send({method:'initialized'});
    const {thread} = await peer.call('thread/start', {ephemeral:true, sandbox:'read-only', approvalPolicy:'never'}, 30000);
    const inventory = await peer.call('mcpServerStatus/list', {threadId:thread.id, serverName:server}, 60000);
    const connector = inventory.data.find(item => item.name === server);
    if (!connector?.tools?.[sendTool] || !connector.tools[profileTool]) throw Error('Gmail 连接或发信工具不可用');
    const invoke = (tool, args) => peer.call('mcpServer/tool/call',
      {threadId:thread.id, server, tool, arguments:args}, 30000);
    const profile = await invoke(profileTool, {});
    const email = profile.structuredContent?.email;
    if (profile.isError || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw Error('无法确认当前连接的 Gmail 邮箱');
    }
    return await operation(email, args => invoke(sendTool, args));
  } finally {
    child.stdin.end();
    child.kill();
  }
}

export function createGmailTransport(home, backendPath, session = withGmail) {
  const file = path.join(home, 'gmail-notifications.json');
  function binding() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return saved.version === 1 && typeof saved.email === 'string' && saved.email ? saved.email : null;
    } catch { return null; }
  }
  return {
    isConfigured: () => Boolean(binding()),
    bind: () => session(backendPath, async email => {
      atomicWrite(file, {version:1, email});
      return {provider:'Gmail', recipient:email, configured:true};
    }),
    send: async message => {
      const boundEmail = binding();
      if (!boundEmail) throw Error('尚未配置收件邮箱');
      await session(backendPath, async (email, send) => {
        if (email.toLowerCase() !== boundEmail.toLowerCase()) throw Error('当前 Gmail 账号与配置不符');
        let response;
        try {
          response = await send({to:'me', subject:message.subject, response_fields:['id'],
            payload:{mime_type:'text/plain',charset:'utf-8',body:{content:message.body}}});
        } catch {
          throw Object.assign(Error('Gmail 发信结果待核对'), {uncertain:true});
        }
        if (response.isError || !(response.structuredContent?.id || response.structuredContent?.message_id ||
          response.structuredContent?.message?.id)) {
          throw Object.assign(Error('Gmail 未返回可核对的邮件 ID'), {uncertain:true});
        }
      });
    }
  };
}
