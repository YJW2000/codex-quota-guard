import readline from 'node:readline';
import fs from 'node:fs';
const mode=process.env.QUOTA_TEST_MODE||'good';
if(process.env.QUOTA_TEST_PID)fs.writeFileSync(process.env.QUOTA_TEST_PID,String(process.pid));
if(mode==='crash')process.exit(1);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 if(process.env.QUOTA_TEST_LOG)fs.appendFileSync(process.env.QUOTA_TEST_LOG,m.method+'\n');
 if(mode==='hang')return;
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));
 else if(m.method==='account/rateLimits/read'){
  if(mode==='fail')console.log(JSON.stringify({id:m.id,error:{code:-1,message:'offline'}}));
  else console.log(JSON.stringify({id:m.id,result:mode==='missing'?{}:{accountId:'fixture',ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:12},secondary:null}}}));
 } else {console.error('UNSAFE METHOD');process.exit(7);}
});
