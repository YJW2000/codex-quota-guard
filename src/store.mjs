import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig } from './quota.mjs';

export function stateDirectory() {
  return process.env.CODEX_QUOTA_GUARD_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CodexQuotaGuard');
}
export function pipeName(home = stateDirectory()) {
  const id = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\codex-quota-guard-${id}` : path.join(home, 'control.sock');
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}
export function loadToken(home = stateDirectory()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'token');
  try { fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFileSync(file, 'utf8').trim();
}
export class Store {
  constructor(home) {
    this.home = home; this.file = path.join(home, 'state.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('恢复队列损坏，已停止自动执行。请保留 state.json 后修复。', { cause: error });
      this.data = { version: 1, config: { ...DEFAULT_CONFIG }, jobs: [], lastError: null };
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.jobs)) throw new Error('Unsupported state format');
    this.data.config = validateConfig(this.data.config);
    // An unacknowledged write may have reached the engine. Never blindly replay it.
    for (const job of this.data.jobs) if (job.state === 'dispatching') {
      job.state = 'attention'; job.reason = '续跑应答丢失；请核对原聊天后手动处理，防止重复执行';
    }
    this.save();
  }
  save() { atomicWrite(this.file, this.data); }
}
