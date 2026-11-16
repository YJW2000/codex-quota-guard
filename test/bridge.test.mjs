import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runDaemon } from '../src/daemon.mjs';
import { runBridge } from '../src/bridge.mjs';
import { Peer } from '../src/rpc.mjs';
import { control, connectControl, ROOT } from '../src/client.mjs';
import { testHome, cleanHome } from './helpers.mjs';

const engineFile = fileURLToPath(new URL('./fixtures/engine.mjs', import.meta.url));
async function waitFor(fn, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await delay(30); }
  throw new Error('Condition timed out');
}
test('real stdio relay: pause projects, save new input, resume and deduplicate', { timeout: 30_000 }, async t => {
  const home = testHome();
  const daemon = await runDaemon({ home });
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const bridge = await runBridge(['app-server'], { input: stdin, output: stdout, backendPath: process.execPath, backendArgs: [engineFile], home, test: true });
  const app = new Peer(stdout, stdin);
  t.after(async () => { bridge.close(); stdin.end(); bridge.child.kill(); await daemon.shutdown(); await delay(50); cleanHome(home); });
  assert.equal((await app.call('initialize', { clientInfo: { name: 'guard-test', version: '1' } })).userAgent, 'test-engine');
  app.send({ method: 'initialized' });
  await waitFor(() => daemon.controller.policy('fixture-account').state === 'running');
  for (const id of ['project-a', 'project-b']) {
    await app.call('thread/start', { id }); await app.call('turn/start', { threadId: id, input: [{ type: 'text', text: 'work' }] });
  }
  const arbitrary = { text: '测试 \\ "quotes"', unrecognizedField: { kept: true } };
  assert.deepEqual(await app.call('fixture/echo', arbitrary), arbitrary);
  await app.call('fixture/usage', { used: 95 });
  await waitFor(() => daemon.controller.store.data.jobs.filter(j => j.kind === 'continue' && j.state === 'pending').length === 2);
  const message = { threadId: 'project-a', clientUserMessageId: 'new-input', input: [{ type: 'text', text: 'next step' }], model: 'preserve-model', approvalPolicy: 'on-request' };
  await assert.rejects(app.call('turn/start', message), e => e.data?.type === 'quota_guard_paused');
  await assert.rejects(app.call('turn/start', message));
  assert.equal(daemon.controller.store.data.jobs.filter(j => j.kind === 'request').length, 1);
  await app.call('fixture/usage', { used: 0 }); await control('check', {}, { home });
  await waitFor(() => daemon.controller.store.data.jobs.filter(j => j.kind === 'continue' && j.state === 'done').length === 2);
  await app.call('fixture/complete', { threadId: 'project-a' }); await control('check', {}, { home });
  const queued = await waitFor(() => daemon.controller.store.data.jobs.find(j => j.key === 'new-input' && j.state === 'done'));
  assert.equal(queued.params.model, 'preserve-model'); assert.equal(queued.params.approvalPolicy, 'on-request');
  const replay = await app.call('turn/start', message); assert.deepEqual(replay, queued.result);
  const turns = await app.call('thread/turns/list', { threadId: 'project-a' }); assert.equal(turns.data.length, 3);
});

test('local control endpoint authenticates and MCP tools are discoverable', { timeout: 15_000 }, async t => {
  const home = testHome(); const daemon = await runDaemon({ home });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.mjs'), 'mcp'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_QUOTA_GUARD_HOME: home } });
  const peer = new Peer(child.stdout, child.stdin);
  t.after(async () => { child.stdin.end(); child.kill(); await daemon.shutdown(); await delay(50); cleanHome(home); });
  const initialized = await peer.call('initialize', { protocolVersion: '2025-06-18' }); assert.equal(initialized.protocolVersion, '2025-06-18');
  const listed = await peer.call('tools/list'); assert.equal(listed.tools.length, 6);
  const status = await peer.call('tools/call', { name: 'guard_status', arguments: {} }); assert.equal(status.structuredContent.pendingCount, 0);
  await assert.rejects(peer.call('tools/call', { name: 'guard_status', arguments: { unexpected: 'value' } }));
  const client = await connectControl({ home, start: false }); await assert.rejects(client.call('engine.call', { method: 'turn/start' })); client.output.end();
});
