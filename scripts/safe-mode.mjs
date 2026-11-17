// Offline fallback used by rollback if the monitor crashed. Only our new ledger.
import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite} from '../src/store.mjs';
const file=path.join(process.argv[2],'automation-state.json');
try{
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(path.join(path.dirname(file),'automation-safe-mode'),'safe\n',{mode:0o600});
 const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,jobs:[]};
 if(data.version!==1||!Array.isArray(data.jobs))throw Error('Unknown ledger format');
 data.enabled=false;if(data.config)data.config.enabled=false;atomicWrite(file,data);
}catch{console.error('Automation ledger preserved; offline safe-mode update failed.');process.exitCode=1;}
