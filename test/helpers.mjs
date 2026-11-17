import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../.cache/tests/',import.meta.url));
export function testHome(){fs.mkdirSync(root,{recursive:true});return fs.mkdtempSync(path.join(root,'run-'));}
export function cleanHome(home){const p=path.resolve(home);if(!p.startsWith(path.resolve(root)+path.sep))throw new Error('Unsafe cleanup');fs.rmSync(p,{recursive:true,force:true});}
export function usage(used=10,weekly=20){return {accountId:'fixture',ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:used},secondary:{usedPercent:weekly}}};}
