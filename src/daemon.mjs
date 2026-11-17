import net from 'node:net';
import {createGuard} from './guard-service.mjs';
import {timingSafeEqual} from 'node:crypto';
import {Peer} from './rpc.mjs';
import {Store,loadToken,pipeName,stateDirectory} from './store.mjs';
import {installation} from './client.mjs';
import {QuotaReader} from './reader.mjs';
import {Monitor} from './monitor.mjs';
export async function runDaemon({home=stateDirectory(),reader}={}) {
  const token=loadToken(home),store=new Store(home);
  const monitor=new Monitor(store,reader||new QuotaReader({...installation(),timeoutMs:store.config.timeoutMs}));
  let guard,guardError;try{guard=createGuard(home,()=>store.config,installation());}catch(e){guardError=e.message;}
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
            case 'status':result={...monitor.status(),automation:guard?.status()||{enabled:false,error:guardError}};break;
            case 'check':await guard?.tick();result=await monitor.check();break;
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
  async function check(){if(stopped)return;await Promise.all([monitor.check(),guard?.tick()]);if(!stopped){clearTimeout(timer);timer=setTimeout(check,store.config.pollMs);}}
  async function shutdown(){if(stopped)return;stopped=true;clearTimeout(timer);monitor.close();guard?.close();for(const p of peers)p.output.destroy();await new Promise(r=>server.close(r));}
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  check();return {monitor,server,shutdown};
}
