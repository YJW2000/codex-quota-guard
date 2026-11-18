import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {Peer} from './rpc.mjs';
export class QuotaReader extends EventEmitter {
  constructor({backendPath,backendArgs=[],timeoutMs=12000,spawnProcess=spawn}={}) {
    super(); Object.assign(this,{backendPath,backendArgs,timeoutMs,spawnProcess}); this.child=null; this.initializing=null;
  }
  async connect() {
    if(this.initializing) return this.initializing;
    if(!this.backendPath || /(?:^|[\\/])codex-quota-(?:bridge|monitor)\.exe$/i.test(this.backendPath)) throw new Error('未找到原版 Codex CLI');
    const env={...process.env};
    // Child-only sanitization; never write the desktop launch environment.
    delete env.CODEX_CLI_PATH; delete env.CODEX_APP_RUNTIME_CLI_PATH; delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    const child=this.child=this.spawnProcess(this.backendPath,[...this.backendArgs,'app-server'],{windowsHide:true,stdio:['pipe','pipe','ignore'],env});
    const peer=this.peer=new Peer(child.stdout,child.stdin);
    child.once('error',()=>peer.fail(new Error('额度查询进程无法启动')));
    child.once('exit',()=>peer.fail(new Error('额度查询进程已退出')));
    peer.on('disconnect',()=>{ if(this.child===child) { this.close(); this.emit('unavailable'); } });
    peer.on('message',request=>{ if(request.id!==undefined && request.method) peer.reject(request,new Error('Read-only monitor')); });
    this.initializing=peer.call('initialize',{clientInfo:{name:'codex_quota_monitor',version:'0.4.1'}},this.timeoutMs)
      .then(()=>peer.send({method:'initialized'})).catch(e=>{this.close();throw e;});
    return this.initializing;
  }
  async read() {
    let timer;
    try {
      return await Promise.race([
        (async()=>{await this.connect();return await this.peer.call('account/rateLimits/read',{},this.timeoutMs);})(),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Quota read deadline exceeded')),this.timeoutMs);})
      ]);
    } catch(e) {this.close();throw e;} finally {clearTimeout(timer);}
  }
  close() {
    const child=this.child, peer=this.peer; this.child=null; this.peer=null; this.initializing=null;
    peer?.fail(new Error('Monitor reader closed'));
    if(child && child.exitCode===null) {child.stdin.destroy();child.kill();}
  }
}
