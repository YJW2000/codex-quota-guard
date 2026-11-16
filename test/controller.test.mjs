import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, usage, FakeAdapter } from './helpers.mjs';
import { Store } from '../src/store.mjs';

test('pause all projects and children, resume all once on actual recovery', async t => {
  const { controller: c, store, adapter: a } = fixture(t);
  a.thread('project-a').thread('project-b').thread('child', { child: true }); a.snapshot = usage(95);
  await c.tick(); assert.equal(store.data.jobs.length, 3); assert.equal(a.calls.filter(x => x.method === 'turn/interrupt').length, 3);
  a.snapshot = usage(0, 97); await c.tick(); assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0);
  a.snapshot = usage(0, 0); await c.tick(); await c.tick();
  assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 3); assert.equal(c.status().pendingCount, 0);
});
test('interruption record is durable before interrupt RPC', async t => {
  const { controller: c, store, adapter: a } = fixture(t); a.thread('a'); a.snapshot = usage(99);
  const call = a.call.bind(a); a.call = async (method, params) => {
    if (method === 'turn/interrupt') assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).jobs[0].state, 'interrupting');
    return call(method, params);
  }; await c.tick();
});
test('new requests deduplicate and same chat drains sequentially', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a', { active: false }); a.snapshot = usage(99); await c.tick();
  const m = id => ({ method: 'turn/start', params: { threadId: 'a', clientUserMessageId: id, input: [{ type: 'text', text: id }] } });
  assert.equal(c.capture(a, m('first')).id, c.capture(a, m('first')).id); c.capture(a, m('second'));
  a.snapshot = usage(); await c.tick(); assert.equal(store.data.jobs[0].state, 'done'); assert.equal(store.data.jobs[1].state, 'pending');
  a.threads.get('a').active = false; await c.tick(); assert.equal(store.data.jobs[1].state, 'done');
});
test('manually canceled or independently advanced chat is not resurrected', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a').thread('b'); a.snapshot = usage(98); await c.tick();
  c.cancelThread('a', 'account-a'); a.threads.get('b').latestTurn = { id: 'user-new-turn', status: 'completed' };
  a.snapshot = usage(); await c.tick(); assert.ok(store.data.jobs.every(j => j.state === 'canceled'));
  assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0);
});
test('awaiting approval and archived chats are never auto-started', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a', { approvalWaiting: true }).thread('b'); a.snapshot = usage(98); await c.tick();
  a.threads.get('a').approvalWaiting = false; a.threads.get('b').archived = true;
  a.snapshot = usage(); await c.tick(); assert.equal(store.data.jobs[0].state, 'attention'); assert.equal(store.data.jobs[1].state, 'canceled');
});
test('account switch does not execute old account queue', async t => {
  const { controller: c, adapter: a } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  a.snapshot = usage(0, 0, 'account-b'); await c.tick(); assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0);
});
test('read failures close gate and interrupt known running work', async t => {
  const { controller: c, adapter: a } = fixture(t); a.thread('a'); a.failQuota = true; await c.tick();
  assert.equal(c.policy(a.accountId).state, 'unknown'); assert.equal(a.calls.filter(x => x.method === 'turn/interrupt').length, 1);
});
test('uncertain dispatch requires attention instead of blind retry', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  a.snapshot = usage(); a.failStart = true; await c.tick(); await c.tick();
  assert.equal(store.data.jobs[0].state, 'attention'); assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 1);
});
test('state restart preserves pending work and quarantines in-flight writes', async t => {
  const { controller: c, adapter: a, store, home } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  assert.equal(new Store(home).data.jobs[0].state, 'pending');
  store.data.jobs[0].state = 'dispatching'; store.save(); assert.equal(new Store(home).data.jobs[0].state, 'attention');
});
test('disabled guard preserves queue and does not resume', async t => {
  const { controller: c, adapter: a } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  c.configure({ enabled: false }); a.snapshot = usage(); await c.tick();
  assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0); assert.equal(c.policy(a.accountId).state, 'disabled');
});
test('interrupt timeout is retried; completed work is canceled on recovery', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a'); a.snapshot = usage(98); a.failInterrupt = true;
  await c.tick(); assert.equal(store.data.jobs[0].state, 'interrupting');
  a.failInterrupt = false; await c.tick(); assert.equal(store.data.jobs[0].state, 'pending');
});
test('missing data and expired snapshot never authorize recovery', async t => {
  const { controller: c, adapter: a } = fixture(t); c.applySnapshot(a, usage());
  c.quotas.get(a.accountId).checkedAt -= 100_000; assert.equal(c.policy(a.accountId).state, 'unknown');
});
test('multiple bridges with shared account are controlled', async t => {
  const { controller: c, adapter: a } = fixture(t); const b = new FakeAdapter(); c.addAdapter('two', b);
  a.thread('a'); b.thread('b'); a.snapshot = b.snapshot = usage(98); await c.tick();
  assert.equal(a.calls.filter(x => x.method === 'turn/interrupt').length, 1); assert.equal(b.calls.filter(x => x.method === 'turn/interrupt').length, 1);
  a.snapshot = b.snapshot = usage(); await c.tick();
  assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 1); assert.equal(b.calls.filter(x => x.method === 'turn/start').length, 1);
});
test('corrupt state fails closed instead of discarding recovery data', t => {
  const { store, home } = fixture(t); fs.writeFileSync(store.file, '{bad'); assert.throws(() => new Store(home), /损坏/);
});
test('reconnected bridge restores pending work on its loaded engine', async t => {
  const { controller: c, adapter: a } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  c.removeAdapter('one'); c.addAdapter('reconnected', a); a.snapshot = usage(); await c.tick();
  assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 1);
});
test('a quota change while loading a chat prevents dispatch', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  a.snapshot = usage(); a.ensureLoaded = async () => c.applySnapshot(a, usage(99)); await c.tick();
  assert.equal(store.data.jobs[0].state, 'pending'); assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0);
});
test('canceling while loading a chat prevents dispatch', async t => {
  const { controller: c, adapter: a, store } = fixture(t); a.thread('a'); a.snapshot = usage(98); await c.tick();
  a.snapshot = usage(); a.ensureLoaded = async () => c.cancel(store.data.jobs[0].id); await c.tick();
  assert.equal(store.data.jobs[0].state, 'canceled'); assert.equal(a.calls.filter(x => x.method === 'turn/start').length, 0);
});
test('an old in-flight quota response cannot undo an account switch', async t => {
  const { controller: c, adapter: a } = fixture(t);
  const call = a.call.bind(a); a.call = async (method, params) => {
    const response = await call(method, params);
    if (method === 'account/rateLimits/read') c.invalidateAdapter(a);
    return response;
  };
  await c.tick(); assert.equal(a.accountId, null); assert.equal(c.quotas.size, 0);
});
