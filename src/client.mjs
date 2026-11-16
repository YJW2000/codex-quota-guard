import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from './rpc.mjs';
import { stateDirectory, loadToken, pipeName } from './store.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function installation(root = ROOT) {
  const file = path.join(root, 'installation.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}
export async function connectControl({ home = stateDirectory(), role = 'client', start = true, metadata = {} } = {}) {
  const token = loadToken(home);
  let started = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const connection = net.createConnection(pipeName(home));
        connection.once('connect', () => resolve(connection)); connection.once('error', reject);
      });
      const peer = new Peer(socket);
      await peer.call('hello', { token, role, ...metadata }, 5000);
      return peer;
    } catch (error) {
      if (!start) throw error;
      if (!started) {
        started = true;
        const installed = path.join(process.env.LOCALAPPDATA || '', 'CodexQuotaGuard', 'app', 'src', 'main.mjs');
        const entry = fs.existsSync(installed) ? installed : path.join(ROOT, 'src/main.mjs');
        const child = spawn(process.execPath, [entry, 'daemon'], {
          detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_QUOTA_GUARD_HOME: home },
        });
        child.on('error', () => {}); child.unref();
      }
      await delay(100);
    }
  }
  throw new Error('额度守卫后台未启动；请运行诊断并检查恢复队列');
}

export async function control(method, params = {}, options = {}) {
  const peer = await connectControl(options);
  try { return await peer.call(method, params, 120_000); }
  finally { peer.output.end(); }
}
