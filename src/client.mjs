import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Peer} from './rpc.mjs';
import {stateDirectory,pipeName} from './store.mjs';
import {unavailable} from './quota.mjs';
export const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function installation(root=ROOT) {
  try{return JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'));}catch{return {};}
}
export async function control(method='status',params={}, {home=stateDirectory(),timeoutMs=2000}={}) {
  let socket,peer;
  try {
    const token=fs.readFileSync(path.join(home,'monitor-token'),'utf8').trim();
    socket=net.createConnection(pipeName(home));peer=new Peer(socket);
    await peer.call('hello',{token},timeoutMs);
    return await peer.call(method,params,method==='check'?16000:timeoutMs);
  }catch{return unavailable('监控组件未运行或连接失败');}
  finally{socket?.destroy();peer?.fail(new Error('Control closed'));}
}
export function startMonitor(home=stateDirectory()) {
  const config=installation();
  if(config.mode!=='independent-monitor') throw new Error('请先安装独立监控版本');
  const child=spawn(process.execPath,[path.join(ROOT,'src/main.mjs'),'daemon'],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_QUOTA_GUARD_HOME:home}});
  child.on('error',()=>{});child.unref();
}
