import {runBridge} from './bridge.mjs';
import {runDaemon} from './daemon.mjs';
import {control,startMonitor} from './client.mjs';
import {serveMcp} from './mcp.mjs';
const [command='status',...args]=process.argv.slice(2);
try{
  if(command==='bridge')await runBridge(args[0]==='--'?args.slice(1):args);
  else if(command==='mcp')serveMcp();
  else if(command==='daemon')await runDaemon();
  else if(command==='start')startMonitor();
  else if(['status','check','enable','disable','configure','shutdown','guard.status','guard.enable','guard.safeMode','guard.cancelJob'].includes(command))console.log(JSON.stringify(await control(command,['configure','guard.cancelJob'].includes(command)?JSON.parse(args.join(' ')||'{}'):{}),null,2));
  else throw new Error('独立监控不支持启动 Codex 或执行任务');
}catch{console.error('额度监控暂不可用');process.exitCode=1;}
