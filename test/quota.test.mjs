import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuota, validateConfig, DEFAULT_CONFIG } from '../src/quota.mjs';

export function snapshot(primary = 10, secondary = 20, accountId = 'account-a') {
  return { accountId, ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: primary, resetsAt: 2000, windowDurationMins: 300 }, secondary: { usedPercent: secondary, resetsAt: 3000, windowDurationMins: 10080 } } };
}
test('6% may run; 5% and zero pause', () => {
  assert.equal(evaluateQuota(snapshot(94)).state, 'running');
  assert.equal(evaluateQuota(snapshot(95)).state, 'paused');
  assert.equal(evaluateQuota(snapshot(100)).state, 'paused');
});
test('weekly window still blocks after primary resets', () => {
  assert.equal(evaluateQuota(snapshot(0, 96)).state, 'paused');
  assert.equal(evaluateQuota(snapshot(0, 94)).state, 'running');
});
test('prefer multi bucket view, watch all windows and spend control', () => {
  const s = snapshot(99); s.rateLimitsByLimitId = { codex: snapshot(0).rateLimits, other: snapshot(10, 96).rateLimits };
  assert.equal(evaluateQuota(s).state, 'paused');
  delete s.rateLimitsByLimitId.other; assert.equal(evaluateQuota(s).state, 'running');
  s.rateLimitsByLimitId.codex.spendControlReached = true; assert.equal(evaluateQuota(s).state, 'paused');
});
test('null and missing data never mean zero consumption or recovery', () => {
  for (const value of [null, {}, { accountId: 'a', ordinaryUsageAllowed: true, rateLimits: { primary: null } }, { ...snapshot(), ordinaryUsageAllowed: null }, { ...snapshot(), accountId: null }]) assert.equal(evaluateQuota(value).state, 'unknown');
  const s = snapshot(); s.rateLimits.primary.usedPercent = null; s.rateLimits.secondary = null;
  assert.equal(evaluateQuota(s).state, 'unknown');
});
test('backend denial wins over percentages and prepaid credits', () => {
  const s = snapshot(0); s.ordinaryUsageAllowed = false; s.rateLimits.credits = { hasCredits: true, unlimited: true };
  assert.equal(evaluateQuota(s).state, 'paused');
});
test('individual spend window and clamping', () => {
  const s = snapshot(-4); s.rateLimits.individualLimit = { remainingPercent: 3, resetsAt: 2000 };
  const q = evaluateQuota(s); assert.equal(q.state, 'paused'); assert.equal(q.windows[0].remainingPercent, 100);
});
test('reset time schedules recheck, not assumed recovery', () => {
  const q = evaluateQuota(snapshot(99), DEFAULT_CONFIG, 1_999_000);
  assert.equal(q.nextCheckAt, 2_001_000); assert.equal(q.state, 'paused');
});
test('configuration rejects invalid values', () => {
  for (const patch of [{ reservePercent: 0 }, { reservePercent: '5' }, { fastPollMs: 0 }, { enabled: 'yes' }, { unexpected: true }]) assert.throws(() => validateConfig(patch));
});
