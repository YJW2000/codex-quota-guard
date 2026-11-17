import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {validateConfig} from './quota.mjs';
export function stateDirectory() { return process.env.CODEX_QUOTA_GUARD_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'.local/share'),'CodexQuotaGuard'); }
export function pipeName(home=stateDirectory()) {
  const id=createHash('sha256').update(path.resolve(home)).digest('hex').slice(0,24);
  const slash=String.fromCharCode(92); return process.platform==='win32' ? slash.repeat(2)+'.'+slash+'pipe'+slash+'codex-quota-monitor-'+id : path.join(home,'monitor.sock');
}
export function atomicWrite(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd=fs.openSync(temp,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(value,null,2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp,file); } finally { fs.rmSync(temp,{force:true}); }
}
export function loadToken(home) {
  fs.mkdirSync(home,{recursive:true,mode:0o700}); const file=path.join(home,'monitor-token');
  try { fs.writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600}); } catch(e) { if(e.code!=='EEXIST') throw e; }
  return fs.readFileSync(file,'utf8').trim();
}
export class Store {
  constructor(home) {
    this.home=home; this.file=path.join(home,'monitor-config.json');
    let data={}; try { data=JSON.parse(fs.readFileSync(this.file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw new Error('监控配置暂不可用'); }
    this.config=validateConfig(data);
    // v0.1 state.json and its pending jobs are never read or executed.
  }
  configure(patch) { this.config=validateConfig({...this.config,...patch}); atomicWrite(this.file,this.config); }
}
