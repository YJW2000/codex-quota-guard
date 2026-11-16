import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from '../src/client.mjs';
import { testHome, cleanHome } from './helpers.mjs';
import { Peer } from '../src/rpc.mjs';
const executable = path.join(ROOT, 'dist', 'codex-quota-bridge.exe');
const available = process.platform === 'win32' && fs.existsSync(executable);
test('native Windows launcher preserves spaces, Unicode, quotes and backslashes', { skip: !available }, t => {
  const home = testHome(); t.after(() => cleanHome(home)); fs.mkdirSync(path.join(home, 'dist'));
  const native = path.join(home, 'dist', 'codex-quota-bridge.exe'); fs.copyFileSync(executable, native);
  fs.writeFileSync(path.join(home, 'installation.json'), JSON.stringify({ root: home, stateDir: home, nodePath: process.execPath, backendPath: process.execPath }));
  const echo = path.join(home, 'echo.mjs'); fs.writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const args = ['', 'a b', '中文路径\\文件', 'embedded"quote', 'slashes before\\"quote', 'trailing space \\', 'plain'];
  assert.deepEqual(JSON.parse(execFileSync(native, [echo, ...args], { encoding: 'utf8', windowsHide: true })), args);
});
test('temporary native power request releases on stdin close', { skip: !available, timeout: 5000 }, async () => {
  const child = spawn(executable, ['--power'], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  child.stdin.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0);
});
test('native launcher relays interactive RPC without waiting for stdin EOF', { skip: !available, timeout: 10000 }, async t => {
  const home = testHome(); fs.mkdirSync(path.join(home, 'dist'));
  const native = path.join(home, 'dist', 'codex-quota-bridge.exe'); fs.copyFileSync(executable, native);
  fs.writeFileSync(path.join(home, 'installation.json'), JSON.stringify({ root: home, stateDir: home, nodePath: process.execPath, backendPath: process.execPath }));
  const echo = path.join(home, 'echo.mjs'); fs.writeFileSync(echo, "import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line',x=>console.log(JSON.stringify({id:JSON.parse(x).id,result:{ok:true}})));");
  const child = spawn(native, [echo], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const peer = new Peer(child.stdout, child.stdin);
  t.after(async () => { child.stdin.end(); child.kill(); await new Promise(r => setTimeout(r, 100)); cleanHome(home); });
  assert.deepEqual(await peer.call('ping', {}, 5000), { ok: true });
});
test('background workers do not inherit extra launcher stdio handles', { skip: !available, timeout: 10000 }, async t => {
  const home = testHome(); fs.mkdirSync(path.join(home, 'dist'));
  const native = path.join(home, 'dist', 'codex-quota-bridge.exe'); fs.copyFileSync(executable, native);
  fs.writeFileSync(path.join(home, 'installation.json'), JSON.stringify({ root: home, stateDir: home, nodePath: process.execPath, backendPath: process.execPath }));
  const script = path.join(home, 'worker.mjs'); fs.writeFileSync(script, "import {spawn} from 'node:child_process'; import readline from 'node:readline'; const worker=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore',detached:true,windowsHide:true}); worker.unref(); readline.createInterface({input:process.stdin}).on('line',x=>console.log(JSON.stringify({id:JSON.parse(x).id,result:{pid:worker.pid}})));");
  const child = spawn(native, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let worker;
  t.after(async () => { child.stdin.end(); child.kill(); if (worker) try { process.kill(worker); } catch {} await new Promise(r => setTimeout(r, 100)); cleanHome(home); });
  const peer = new Peer(child.stdout, child.stdin); worker = (await peer.call('ping', {}, 3000)).pid;
  const closed = once(child, 'close'); child.stdin.end();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('stdio leaked into background worker')), 3000); timer.unref(); })]);
});
