import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createAlertCollector} from '../src/alert-events.mjs';
import {createMailOutbox} from '../src/mail.mjs';
import {createGuard} from '../src/guard-service.mjs';
import {evaluateQuota, DEFAULT_CONFIG, unavailable} from '../src/quota.mjs';
import {FakeAdapter, usage} from './guard-helpers.mjs';
import {testHome, cleanHome} from './helpers.mjs';

function setup(t) {
  const home = testHome(); t.after(() => cleanHome(home));
  const outbox = createMailOutbox(home, {isConfigured: () => false});
  return {home, outbox, collector: createAlertCollector(home, outbox)};
}

function weekly(accountId, usedPercent, resetsAt) {
  return evaluateQuota({accountId, ordinaryUsageAllowed: true,
    rateLimits: {primary: {windowDurationMins: 10080, usedPercent, resetsAt}}});
}

test('weekly-only warnings persist across checks and restarts and are isolated by account and reset', t => {
  const {home, outbox, collector} = setup(t);
  const low = weekly('account-A', 95, 9000);
  collector.observeQuota(low);
  collector.observeQuota(low);
  const restarted = createAlertCollector(home, outbox);
  restarted.observeQuota(weekly('account-A', 100, 9000));
  restarted.observeQuota(weekly('account-B', 97, 9000));
  restarted.observeQuota(weekly('account-A', 95, 12000));
  assert.equal(outbox.status().pending, 3);
  for (const name of ['weekly-alert-windows.json', 'mail-outbox.json'])
    assert.doesNotMatch(fs.readFileSync(path.join(home, name),'utf8'), /account-[AB]/);
});

test('a missing weekly reset is one durable episode until measured recovery', t => {
  const {home, outbox, collector} = setup(t);
  collector.observeQuota(weekly('A', 98, null));
  const restarted = createAlertCollector(home, outbox);
  restarted.observeQuota(unavailable()); restarted.observeQuota(weekly('A', 99, 10000));
  restarted.observeQuota(weekly('A', 100, null));
  assert.equal(outbox.status().pending, 1);
  restarted.observeQuota(weekly('A', 80, 10000));
  restarted.observeQuota(weekly('A', 95, 10000));
  assert.equal(outbox.status().pending, 1);
  restarted.observeQuota(weekly('A', 80, null));
  restarted.observeQuota(weekly('A', 98, null));
  assert.equal(outbox.status().pending, 2);
});

test('acknowledged interrupts and committed queues share an account/5-hour alert, even with no reset time', async t => {
  const {home, outbox, collector} = setup(t);
  const guard = createGuard(home, () => ({...DEFAULT_CONFIG}));
  const adapter = new FakeAdapter(); adapter.snapshot = usage(99);
  adapter.snapshot.rateLimits.primary.resetsAt = null; guard.controller.addAdapter('one', adapter);
  await guard.tick();
  const request = id => ({method:'turn/start',params:{threadId:id,input:['private prompt']}});
  const proposed = await guard.handle('guard.gate', {message:request('thread-name-private')}, adapter);
  const jobs = guard.controller.store.data.jobs;
  collector.observeJobs(jobs); assert.equal(outbox.status().pending, 0);
  fs.writeFileSync(path.join(home,'automation-commits.jsonl'),JSON.stringify({jobId:proposed.jobId})+'\n');
  await guard.tick();
  collector.observeJobs(jobs); assert.equal(outbox.status().pending, 1);
  adapter.thread('another'); await guard.tick(); collector.observeJobs(jobs);
  assert.equal(outbox.status().pending, 1);

  const restarted = createGuard(home, () => ({...DEFAULT_CONFIG}));
  const next = createAlertCollector(home, outbox);
  restarted.controller.addAdapter('one', adapter); adapter.thread('later'); await restarted.tick();
  next.observeJobs(restarted.controller.store.data.jobs); assert.equal(outbox.status().pending,1);
  adapter.snapshot = usage(20); await restarted.tick(); adapter.snapshot = usage(99);
  adapter.snapshot.rateLimits.primary.resetsAt = null; adapter.thread('new-cycle');
  await restarted.tick(); next.observeJobs(restarted.controller.store.data.jobs);
  assert.equal(outbox.status().pending, 2);
  assert.doesNotMatch(fs.readFileSync(path.join(home,'mail-outbox.json'),'utf8'), /thread-name|private prompt|account-a/);
});

test('unconfirmed proposals, failed interrupts and pre-upgrade jobs do not report a pause', t => {
  const {outbox, collector} = setup(t);
  collector.observeJobs([{state:'proposed',accountId:'A',proposedPauseAlert:{at:1,episodeId:'ep'}},
    {state:'interrupting',accountId:'A',kind:'continue',pauseAlert:{at:1,episodeId:'ep'}}, {state:'done',kind:'request'}]);
  assert.equal(outbox.status().pending, 0);
});

test('mail storage errors are reported without affecting callers and subsequent checks retry', t => {
  const {home, outbox} = setup(t); let fail=true;
  const collector = createAlertCollector(home,{enqueue:e=>{if(fail)throw Error('offline');return outbox.enqueue(e);}});
  const snapshot=weekly('A',97,null);
  collector.observeQuota(snapshot);assert.ok(collector.status().lastError);
  fail=false;const restarted=createAlertCollector(home,outbox);
  restarted.observeQuota(weekly('A',10,null));assert.equal(restarted.status().lastError,null);assert.equal(outbox.status().pending,1);
  fs.writeFileSync(path.join(home,'weekly-alert-windows.json'),'{broken');
  const corrupt=createAlertCollector(home,outbox);corrupt.observeQuota(snapshot);
  assert.ok(corrupt.status().lastError);assert.equal(fs.readFileSync(path.join(home,'weekly-alert-windows.json'),'utf8'),'{broken');
});
