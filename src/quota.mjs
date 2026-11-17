export const DEFAULT_CONFIG = Object.freeze({ enabled: true, reservePercent: 5, pollMs: 30000, timeoutMs: 12000, staleMs: 65000 });
export function validateConfig(patch) {
  for (const [key,value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown setting: ${key}`);
    if (key === 'enabled' ? typeof value !== 'boolean' : !Number.isFinite(value)) throw new Error(`Invalid setting: ${key}`);
  }
  const c={...DEFAULT_CONFIG,...patch};
  if(c.reservePercent<1 || c.reservePercent>50 || c.pollMs<1000 || c.timeoutMs<100 || c.timeoutMs>30000 || c.staleMs<c.pollMs) throw new Error('Invalid monitor settings');
  return c;
}
export function unavailable(reason='监控连接暂不可用') { return {state:'unavailable',label:'暂不可用',windows:[],reason,checkedAt:null}; }
export function evaluateQuota(snapshot,config=DEFAULT_CONFIG,now=Date.now()) {
  if(!snapshot?.accountId || typeof snapshot.ordinaryUsageAllowed !== 'boolean') return unavailable('无法确认账号或额度权限');
  const buckets=snapshot.rateLimitsByLimitId;
  const entries=buckets && Object.keys(buckets).length ? Object.entries(buckets) : [['codex',snapshot.rateLimits]];
  const windows=[]; let blocked=!snapshot.ordinaryUsageAllowed;
  for(const [limitId,bucket] of entries) {
    if(!bucket) continue;
    blocked ||= Boolean(bucket.spendControlReached || bucket.rateLimitReachedType);
    for(const name of ['primary','secondary','individualLimit']) {
      const w=bucket[name]; const remaining=name==='individualLimit' ? w?.remainingPercent : typeof w?.usedPercent==='number' ? 100-w.usedPercent : null;
      if(!Number.isFinite(remaining) || remaining<0 || remaining>100) continue;
      windows.push({limitId,name,remainingPercent:remaining,resetsAt:Number.isFinite(w.resetsAt)?w.resetsAt:null,windowDurationMins:w.windowDurationMins??null});
    }
  }
  if(!windows.length) return unavailable('未取得可用的额度窗口');
  const low=blocked || windows.some(w=>w.remainingPercent<=config.reservePercent);
  return {state:low?'low':'available',label:low?'额度偏低':'额度可用',windows,checkedAt:now,reason:blocked?'账号当前不允许使用订阅额度':null};
}
