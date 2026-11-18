export const DEFAULT_CONFIG = Object.freeze({ enabled: true, preventSleep: true, reservePercent: 5, pollMs: 30000, timeoutMs: 12000, staleMs: 65000 });
export function validateConfig(patch) {
  for (const [key,value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown setting: ${key}`);
    if (['enabled','preventSleep'].includes(key) ? typeof value !== 'boolean' : !Number.isFinite(value)) throw new Error(`Invalid setting: ${key}`);
  }
  const c={...DEFAULT_CONFIG,...patch};
  if(c.reservePercent<1 || c.reservePercent>50 || c.pollMs<1000 || c.timeoutMs<100 || c.timeoutMs>30000 || c.staleMs<c.pollMs) throw new Error('Invalid monitor settings');
  return c;
}
function missingWindow() {
  return {state: 'unavailable', remainingPercent: null, resetsAt: null, limitId: null};
}

function summarize(windows, duration, reserve) {
  let lowest;
  for (const window of windows) {
    if (window.windowDurationMins === duration && (!lowest || window.remainingPercent < lowest.remainingPercent)) {
      lowest = window;
    }
  }
  if (!lowest) return missingWindow();
  const {remainingPercent, resetsAt, limitId} = lowest;
  return {state: remainingPercent <= reserve ? 'low' : 'available', remainingPercent, resetsAt, limitId};
}

export function unavailable(reason = '监控连接暂不可用') {
  return {
    state: 'unavailable', label: '暂不可用', windows: [], reason, checkedAt: null,
    accountId: null, usageAllowed: false, fiveHour: missingWindow(), weekly: missingWindow()
  };
}

export function evaluateQuota(snapshot, config = DEFAULT_CONFIG, now = Date.now()) {
  if (!snapshot?.accountId || typeof snapshot.ordinaryUsageAllowed !== 'boolean') return unavailable('无法确认账号或额度权限');
  const entries = new Map(Object.entries(snapshot.rateLimitsByLimitId ?? {}));
  const base = snapshot.rateLimits;
  if (base && !entries.get(base.limitId || 'codex')) entries.set(base.limitId || 'codex', base);
  const windows = [];
  let usageAllowed = snapshot.ordinaryUsageAllowed;
  for (const [limitId, bucket] of entries) {
    if (!bucket) continue;
    if (bucket.spendControlReached || bucket.rateLimitReachedType) usageAllowed = false;
    for (const name of ['primary', 'secondary', 'individualLimit']) {
      const window = bucket[name];
      const remaining = name === 'individualLimit' ? window?.remainingPercent :
        typeof window?.usedPercent === 'number' ? 100 - window.usedPercent : null;
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
      windows.push({
        limitId, name, remainingPercent: remaining, resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
        windowDurationMins: window.windowDurationMins ?? null
      });
    }
  }
  if (!windows.length) return unavailable('未取得可用的额度窗口');
  // A plan may put the weekly limit in the primary slot. Only a measured duration identifies a limit.
  const fiveHour = summarize(windows, 300, config.reservePercent);
  const weekly = summarize(windows, 10080, config.reservePercent);
  const labels = {available: '5 小时额度可用', low: '5 小时额度偏低', unavailable: '5 小时额度暂不可用'};
  let label = labels[fiveHour.state];
  if (weekly.state === 'low') label += '，周额度偏低';
  return {
    state: fiveHour.state, label, fiveHour, weekly, windows, checkedAt: now,
    accountId: snapshot.accountId, usageAllowed, reason: usageAllowed ? null : '账号当前限制额度使用'
  };
}
