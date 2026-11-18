import readline from 'node:readline';
let used=10,fail=false;const threads=new Map(),calls=[],requests=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line),p=m.params||{};let result={};calls.push(m.method);requests.push({method:m.method,params:p});
 try{
  if(m.method==='test/set'){
   used=p.used??used;fail=p.fail??fail;
   for(const id of p.threads||[])threads.set(id,{id,status:{type:'active'},turn:{id:'turn-'+id,status:'inProgress'}});
   setTimeout(()=>send({method:'account/rateLimits/updated',params:{}}),10);
  }else if(m.method==='test/state')result={calls,requests,threads:[...threads.values()]};
  else if(m.method==='account/rateLimits/read'){
   if(fail)throw Error('offline');
   result={accountId:'account-a',ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:used,windowDurationMins:300}}};
  }else if(m.method==='thread/loaded/list')result={data:[...threads.keys()]};
  else if(m.method==='thread/read')result={thread:threads.get(p.threadId)||{id:p.threadId,status:{type:'idle'}}};
  else if(m.method==='thread/turns/list')result={data:threads.has(p.threadId)?[threads.get(p.threadId).turn]:[]};
  else if(m.method==='turn/interrupt'){const t=threads.get(p.threadId);t.status={type:'idle'};t.turn.status='interrupted';}
  else if(m.method==='turn/start'){
   const t=threads.get(p.threadId)||{id:p.threadId};t.status={type:'active'};t.turn={id:'new-'+calls.length,status:'inProgress'};threads.set(p.threadId,t);result={turn:t.turn};
  }else if(m.method==='test/partial'){
   process.stdout.write(JSON.stringify({id:m.id,result:{text:'末行不带换行'}}));process.exitCode=7;break;
  }else if(m.method==='test/serverRequest'){
   send({id:'server-approval',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId}});
  }else result={echo:p,extension:{retained:true}};
  if(m.id!==undefined)send({id:m.id,result});
 }catch(e){send({id:m.id,error:{code:-1,message:e.message}});}
}
