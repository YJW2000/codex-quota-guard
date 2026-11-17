import {evaluateQuota,unavailable} from './quota.mjs';
export class Monitor {
  constructor(store,reader,now=Date.now) {
    Object.assign(this,{store,reader,now}); this.value=unavailable();this.pending=null;this.revision=0;
    reader.on?.('unavailable',()=>{this.value=unavailable('额度查询连接已中断');});
  }
  status() {
    if(!this.store.config.enabled) return {...unavailable('监控已关闭'),enabled:false};
    if(this.value.checkedAt!==null && this.now()-this.value.checkedAt>=this.store.config.staleMs) this.value=unavailable('额度数据已过期');
    return {...this.value,enabled:true,reservePercent:this.store.config.reservePercent};
  }
  async check() {
    if(this.pending) return this.pending;
    if(!this.store.config.enabled) return this.status();
    const revision=this.revision;
    this.pending=(async()=>{
      try {const value=evaluateQuota(await this.reader.read(),this.store.config,this.now());if(revision===this.revision)this.value=value;}
      catch {this.value=unavailable('额度查询失败或超时');}
      return this.status();
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
  configure(patch) {this.revision++;this.store.configure(patch);this.value=unavailable('等待重新查询');if(!this.store.config.enabled)this.reader.close();return this.status();}
  close() {this.revision++;this.store.config.enabled=false;this.reader.close();this.value=unavailable('监控已退出');}
}
