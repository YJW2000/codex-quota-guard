import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaemon} from '../src/daemon.mjs';
import {control} from '../src/client.mjs';
import {testHome,cleanHome} from './helpers.mjs';

test('standalone weekly-only monitoring sends one alert with no bridges or paused jobs', async t => {
  const home = testHome(), sent = [];
  const reader = {
    read: async () => ({accountId:'fixture',ordinaryUsageAllowed:true,rateLimits:{
      primary:{usedPercent:98,windowDurationMins:10080,resetsAt:1234567890}}}),
    close() {}
  };
  const daemon = await runDaemon({home,reader,mailTransport:{send:async msg => sent.push(msg)}});
  t.after(async () => {await daemon.shutdown();cleanHome(home);});
  await control('check',{}, {home});
  await control('check',{}, {home});
  const status = await control('status',{}, {home});
  assert.equal(status.fiveHour.state,'unavailable');
  assert.equal(status.weekly.state,'low');
  assert.equal(status.automation.pendingCount,0);
  assert.equal(status.automation.bridges.length,0);
  assert.equal(status.notifications.sent,1);
  assert.equal(sent.length,1);
  assert.match(sent[0].subject,/周额度/);
});
