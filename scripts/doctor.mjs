import {QuotaReader} from '../src/reader.mjs';
import {installation} from '../src/client.mjs';
import {evaluateQuota,unavailable} from '../src/quota.mjs';
const args=process.argv.slice(2), index=args.indexOf('--backend');
const reader=new QuotaReader({...installation(),...(index>=0?{backendPath:args[index+1]}:{})});
try { console.log(JSON.stringify(evaluateQuota(await reader.read()))); }
catch { console.log(JSON.stringify(unavailable('无法连接只读额度查询进程')));process.exitCode=1; }
finally {reader.close();}
