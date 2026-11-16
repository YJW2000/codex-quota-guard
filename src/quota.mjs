export const DEFAULT_CONFIG = Object.freeze({
  enabled: true, reservePercent: 5, fastAtPercent: 15,
  pollMs: 30_000, fastPollMs: 5_000, staleMs: 65_000,
  preventSleep: true,
});

export function validateConfig(patch) {
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    } else if (!Number.isFinite(value)) throw new Error(`${key} must be finite`);
  }
  const config = { ...DEFAULT_CONFIG, ...patch };
  if (config.reservePercent < 1 || config.reservePercent > 50) throw new Error('Reserve must be 1–50%');
  if (config.fastAtPercent < config.reservePercent || config.fastAtPercent > 100) throw new Error('Invalid fast threshold');
  if (config.fastPollMs < 1000 || config.pollMs < config.fastPollMs || config.staleMs < config.pollMs) throw new Error('Invalid polling intervals');
  return config;
}

export function evaluateQuota(snapshot, config = DEFAULT_CONFIG, now = Date.now()) {
  const rows = [];
  const buckets = snapshot?.rateLimitsByLimitId;
  const entries = buckets && Object.keys(buckets).length
    ? Object.entries(buckets) : snapshot?.rateLimits ? [['codex', snapshot.rateLimits]] : [];
  let backendBlocked = snapshot?.ordinaryUsageAllowed === false;
  for (const [limitId, bucket] of entries) {
    if (!bucket) continue;
    backendBlocked ||= bucket.spendControlReached === true || Boolean(bucket.rateLimitReachedType);
    for (const name of ['primary', 'secondary', 'individualLimit']) {
      const window = bucket[name];
      if (!window) continue;
      const raw = name === 'individualLimit' ? window.remainingPercent
        : typeof window.usedPercent === 'number' ? 100 - window.usedPercent : null;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      rows.push({ limitId, name, remainingPercent: Math.max(0, Math.min(100, raw)),
        windowDurationMins: window.windowDurationMins ?? null,
        resetsAt: typeof window.resetsAt === 'number' ? window.resetsAt : null });
    }
  }
  const blocking = rows.filter(row => row.remainingPercent <= config.reservePercent);
  // Permission is authoritative: percentages alone do not establish recovery.
  const known = rows.length > 0 && typeof snapshot?.ordinaryUsageAllowed === 'boolean' && Boolean(snapshot?.accountId);
  const state = !known ? 'unknown' : backendBlocked || blocking.length ? 'paused' : 'running';
  const resetTimes = blocking.map(row => row.resetsAt * 1000).filter(t => t > now);
  const near = rows.some(row => row.remainingPercent <= config.fastAtPercent);
  const interval = near || state !== 'running' ? config.fastPollMs : config.pollMs;
  return { state, windows: rows, blocking, reason: state === 'unknown' ? '额度或账号权限尚未确认'
    : state === 'paused' ? backendBlocked ? '账号当前不允许使用订阅额度' : `剩余额度不超过 ${config.reservePercent}%` : null,
    checkedAt: now, nextCheckAt: Math.min(now + interval, ...resetTimes.map(t => t + 1000)) };
}
