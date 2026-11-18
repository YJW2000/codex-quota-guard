import net from 'node:net';
import {createGuard} from './guard-service.mjs';
import {timingSafeEqual} from 'node:crypto';
import {Peer} from './rpc.mjs';
import {Store,loadToken,pipeName,stateDirectory} from './store.mjs';
import {installation} from './client.mjs';
import {QuotaReader} from './reader.mjs';
import {Monitor} from './monitor.mjs';
import {createMailOutbox} from './mail.mjs';
import {createGmailTransport} from './gmail.mjs';
import {createAlertCollector} from './alert-events.mjs';
export async function runDaemon({home=stateDirectory(),reader,mailTransport}={}) {
  const token=loadToken(home),store=new Store(home);
  const settings = installation();
  const monitor=new Monitor(store,reader||new QuotaReader({...settings,timeoutMs:store.config.timeoutMs}));
  const outbox = createMailOutbox(home, mailTransport ?? createGmailTransport(home, settings.backendPath));
  const alerts = createAlertCollector(home, outbox);
  let mailError = null, delivery = Promise.resolve();
  function flushMail() {
    if (stopped) return;
    delivery = outbox.flush().then(() => {mailError = null;}, () => {mailError = '邮件队列写入失败';});
  }
  function observeJobs(jobs) {
    if (stopped) return;
    alerts.observeJobs(jobs);
    flushMail();
  }
  async function readQuota() {
    const value = await monitor.check();
    if (!stopped) {
      alerts.observeQuota(value);
      flushMail();
    }
    return value;
  }
  function mailStatus() {
    const status = outbox.status();
    return {...status, provider:'Gmail', lastError:alerts.status().lastError || mailError || status.lastError};
  }
  let guard,guardError;try{guard=createGuard(home,()=>store.config,settings,{onJobsChanged:observeJobs});}catch(e){guardError=e.message;}
  const peers=new Set();let timer,stopped=false;
  const server=net.createServer(socket=>{
    const peer=new Peer(socket);peers.add(peer);let authenticated=false,adapter=null;
    const timeout=setTimeout(()=>socket.destroy(),2000);
    peer.on('disconnect',()=>{clearTimeout(timeout);peers.delete(peer);if(adapter)guard?.remove(adapter.id);});
    peer.on('message',async request=>{
      try {
        let result;
        if(request.method==='hello') {
          const candidate=Buffer.from(typeof request.params?.token==='string'?request.params.token:'');
          authenticated=candidate.length===Buffer.byteLength(token)&&timingSafeEqual(candidate,Buffer.from(token));
          if(!authenticated) throw new Error('Unauthorized');
          clearTimeout(timeout);if(request.params.role==='bridge'){if(!guard)throw new Error('Automation unavailable');adapter=guard.add(peer,request.params.engineKey);}result={ok:true};
        }else{
          if(!authenticated)throw new Error('Unauthorized');
          if(request.method.startsWith('guard.')){result=guard?await guard.handle(request.method,request.params,adapter):{enabled:false,error:guardError};peer.reply(request,result);return;}
          switch(request.method){
            case 'status':result={...monitor.status(),notifications:mailStatus(),automation:guard?.status()||{enabled:false,error:guardError}};break;
            case 'check':await guard?.tick();result=await readQuota();break;
            case 'configure':result=monitor.configure(request.params||{});guard?.tick();break;
            case 'enable':result=monitor.configure({enabled:true});guard?.handle('guard.enable');check();break;
            case 'disable':result=monitor.configure({enabled:false});await guard?.handle('guard.safeMode');break;
            case 'shutdown':peer.reply(request,{ok:true});setTimeout(shutdown,20);return;
            default:throw new Error('Read-only quota monitor: unsupported command');
          }
        }
        peer.reply(request,result);
      }catch(e){try{peer.reject(request,e);}catch{}}
    });
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipeName(home),resolve);});}
  catch(e){monitor.close();throw e;}
  async function check(){if(stopped)return;await Promise.all([readQuota(),guard?.tick()]);if(!stopped){clearTimeout(timer);timer=setTimeout(check,store.config.pollMs);}}
  async function shutdown(){if(stopped)return;stopped=true;clearTimeout(timer);monitor.close();guard?.close();await delivery;for(const p of peers)p.output.destroy();await new Promise(r=>server.close(r));}
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  check();return {monitor,server,shutdown};
}
