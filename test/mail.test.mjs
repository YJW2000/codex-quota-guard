import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createMailOutbox } from '../src/mail.mjs';
import { testHome, cleanHome } from './helpers.mjs';

function fixture(t) {
  const home = testHome();
  t.after(() => cleanHome(home));
  return home;
}
const weekly = { kind: 'weekly', key: 'account-a/window-1', remainingPercent: 3 };
const pause = { kind: 'pause', key: 'account-a/pause-1', remainingPercent: 2 };

test('accepted notifications survive restart and concurrent flush without duplicate send', async t => {
  const home = fixture(t);
  const sent = [];
  const options = { isConfigured: () => true, send: async message => { sent.push(message); } };
  const box = createMailOutbox(home, options);
  assert.equal(box.enqueue(weekly), true);
  assert.equal(box.enqueue(weekly), false);
  box.enqueue(pause);
  await Promise.all([box.flush(), box.flush()]);
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /周额度/);
  assert.match(sent[1].subject, /暂停/);
  assert.match(sent[0].body, /3%/);
  assert.equal(box.status().sent, 2);
  const reopened = createMailOutbox(home, options);
  assert.equal(reopened.enqueue(pause), false);
  await reopened.flush();
  assert.equal(sent.length, 2);
});

test('unconfigured notifications stay queued and known send failures back off', async t => {
  const home = fixture(t);
  let configured = false, time = 1000000, attempts = 0;
  const box = createMailOutbox(home, {
    isConfigured: () => configured, now: () => time,
    send: async () => { if (++attempts === 1) throw Error('server refused'); }
  });
  box.enqueue(weekly);
  await box.flush();
  assert.equal(box.status().configured, false);
  assert.equal(box.status().pending, 1);
  assert.equal(attempts, 0);
  configured = true;
  await box.flush();
  await box.flush();
  assert.equal(attempts, 1);
  time += 30000;
  await box.flush();
  assert.deepEqual([attempts,box.status().sent,box.status().pending], [2,1,0]);
});

test('unknown delivery and crash while sending never cause a blind retry', async t => {
  const home = fixture(t);
  let calls = 0;
  const options = { isConfigured: () => true, send: async () => {
    calls++;
    throw Object.assign(Error('lost acknowledgement'), { uncertain: true });
  }};
  const box = createMailOutbox(home, options);
  box.enqueue(pause);
  await box.flush();
  assert.equal(box.status().attention, 1);
  const file = path.join(home,'mail-outbox.json');
  const saved = JSON.parse(fs.readFileSync(file,'utf8'));
  saved.records[0].state = 'sending';
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = createMailOutbox(home, options);
  assert.equal(restarted.status().attention, 1);
  await restarted.flush();
  assert.equal(calls, 1);
});

test('corrupt mail ledger remains untouched and reports the error', async t => {
  const home = fixture(t), file = path.join(home,'mail-outbox.json');
  fs.writeFileSync(file, '{bad');
  const box = createMailOutbox(home);
  assert.match(box.status().lastError, /无法读取/);
  assert.throws(() => box.enqueue(pause), /无法读取/);
  await box.flush();
  assert.equal(fs.readFileSync(file,'utf8'), '{bad');
});
