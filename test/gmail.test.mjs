import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createGmailTransport} from '../src/gmail.mjs';
import {createMailOutbox} from '../src/mail.mjs';
import {testHome,cleanHome} from './helpers.mjs';

const account = 'fixture@example.invalid';
const recipient = 'alerts+quota@example.invalid';

function fixture(t) {
  const home = testHome();
  t.after(() => cleanHome(home));
  const file = path.join(home, 'gmail-notifications.json');
  const calls = [];
  const profile = {email: account};
  const session = (_, operation) => operation(profile.email, async args => {
    calls.push(args);
    return {structuredContent: {id: 'fixture-' + calls.length}};
  });
  const open = () => createGmailTransport(home, 'fixture', session);
  return {home, file, calls, profile, open};
}

test('weekly and five-hour notifications go only to the configured single address after restart', async t => {
  const {home, calls, open} = fixture(t);
  const firstBinding = await open().bind(recipient);
  assert.equal(firstBinding.recipient, recipient);
  assert.equal(calls.length, 0);
  const box = createMailOutbox(home, open());
  box.enqueue({kind:'pause', key:'five-hour-window', remainingPercent:4});
  box.enqueue({kind:'weekly', key:'week-window', remainingPercent:3});
  await box.flush();
  assert.equal(box.status().sent, 2);
  assert.deepEqual(calls.map(call => call.to), [recipient, recipient]);
  assert.match(calls[0].subject, /5 小时/);
  assert.match(calls[1].subject, /周/);
  for (const call of calls) {
    assert.equal(call.cc, undefined);
    assert.equal(call.bcc, undefined);
    assert.equal(call.payload.cc, undefined);
    assert.equal(call.payload.bcc, undefined);
    assert.equal(JSON.stringify(call).includes(account), false);
  }
});

test('legacy v1 binding still delivers to self and revalidating a new binding retains its destination', async t => {
  const {file, calls, open} = fixture(t);
  fs.writeFileSync(file, JSON.stringify({version:1, email:account}));
  assert.equal(open().isConfigured(), true);
  await open().send({subject:'legacy',body:'quota'});
  assert.equal(calls[0].to, 'me');
  await open().bind(recipient);
  assert.equal((await open().bind()).recipient, recipient);
  assert.equal(calls.length, 1);
  await open().send({subject:'after rebind',body:'quota'});
  assert.equal(calls[1].to, recipient);
});

test('switching Gmail accounts cannot deliver an explicitly addressed notification', async t => {
  const {profile, open, calls} = fixture(t);
  await open().bind(recipient);
  profile.email = 'other@example.invalid';
  await assert.rejects(open().send({subject:'pause',body:'quota'}));
  assert.equal(calls.length, 0);
  assert.equal((await open().bind()).recipient, profile.email);
  await open().send({subject:'weekly', body:'quota'});
  assert.equal(calls[0].to, 'me');
});

test('binding refuses multiple recipients and header injection while keeping the existing destination', async t => {
  const {open, file, calls} = fixture(t);
  const mail = open();
  await mail.bind(recipient);
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of ['', 'bad-address', [recipient], recipient+',second@example.invalid',
    recipient+';second@example.invalid', recipient+'\r\nBcc: second@example.invalid']) {
    await assert.rejects(async () => mail.bind(invalid));
    assert.equal(fs.readFileSync(file,'utf8'), before);
  }
  assert.equal(calls.length, 0);
  await open().send({subject:'weekly',body:'quota'});
  assert.equal(calls[0].to, recipient);
});

test('a missing or malformed saved v2 recipient cannot fall back to self', async t => {
  const {open, file, calls} = fixture(t);
  for (const invalid of [undefined, '', recipient+'\r\nBcc: second@example.invalid', [recipient,account]]) {
    fs.writeFileSync(file, JSON.stringify({version:2, email:account, recipient:invalid}));
    const mail = open();
    assert.equal(mail.isConfigured(), false);
    await assert.rejects(mail.send({subject:'pause',body:'quota'}));
  }
  assert.equal(calls.length, 0);
});

test('bind verifies Gmail without sending; quota mail goes only to the bound self', async t => {
  const home = testHome();t.after(() => cleanHome(home));
  let email = 'fixture@example.invalid', calls = [];
  const mail = createGmailTransport(home, 'fixture', (_, operation) =>
    operation(email, async args => {calls.push(args); return {structuredContent:{id:'accepted'}};}));
  await mail.bind();
  assert.equal(mail.isConfigured(), true);
  assert.equal(calls.length, 0);
  await mail.send({subject:'周额度提醒',body:'剩余 5%'});
  assert.equal(calls[0].to, 'me');
  assert.equal(calls[0].payload.body.content,'剩余 5%');
  email = 'other@example.invalid';
  await assert.rejects(mail.send({subject:'x',body:'y'}), /账号/);
  assert.equal(calls.length,1);
});

test('loss of Gmail acknowledgement never reports an accepted email', async t => {
  const home=testHome();t.after(() => cleanHome(home));
  const mail=createGmailTransport(home, 'fixture', (_, operation) =>
    operation('fixture@example.invalid', async () => {throw Error('connection lost');}));
  await mail.bind();
  await assert.rejects(mail.send({subject:'x',body:'y'}), error => error.uncertain === true);
});
