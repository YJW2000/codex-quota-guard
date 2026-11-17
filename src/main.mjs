import {runDaemon} from './daemon.mjs';
import {control,startMonitor} from './client.mjs';
import {serveMcp} from './mcp.mjs';
const [command='status',...args]=process.argv.slice(2);
try{
  if(command==='mcp')serveMcp();
  else if(command==='daemon')await runDaemon();
  else if(command==='start')startMonitor();
  else if(['status','check','enable','disable','configure','shutdown'].includes(command))console.log(JSON.stringify(await control(command,command==='configure'?JSON.parse(args.join(' ')||'{}'):{}),null,2));
  else throw new Error('独立监控不支持启动 Codex 或执行任务');
}catch{console.error('额度监控暂不可用');process.exitCode=1;}
