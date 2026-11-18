import test from 'node:test';
import assert from 'node:assert/strict';
import {createGmailTransport} from '../src/gmail.mjs';
import {testHome,cleanHome} from './helpers.mjs';

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
