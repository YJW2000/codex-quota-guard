import { createHash, randomUUID } from 'node:crypto';
import { advanceLowEpisode } from './alert-events.mjs';
import { evaluateQuota, validateConfig } from './quota.mjs';

export const MODEL_ACTIONS = new Set(['turn/start', 'turn/steer', 'turn/addUserMessage', 'thread/queue/start', 'review/start', 'thread/compact/start', 'thread/startAeon']);
const WAITING = new Set(['pending', 'interrupting', 'dispatching']);
export class Controller {
  constructor(store, { now = Date.now, onChange = () => {} } = {}) {
    this.store = store; this.now = now; this.onChange = onChange;
    this.adapters = new Map(); this.quotas = new Map(); this.busy = false;
  }
  get config() { return this.store.data.config; }
  changed() { this.store.save(); this.onChange(this.status()); }
  addAdapter(id, adapter) { adapter.id = id; this.adapters.set(id, adapter); }
  removeAdapter(id) { this.adapters.delete(id); }
  policy(accountId) {
    if (!this.config.enabled) return { state: 'disabled' };
    const quota = this.quotas.get(accountId);
    if (!quota || this.now() - quota.checkedAt >= this.config.staleMs) return { state: 'unknown', reason: '无法确认最新额度' };
    return quota;
  }
  applySnapshot(adapter, snapshot) {
    const accountId = snapshot?.accountId;
    if (!accountId) throw new Error('额度响应缺少账号标识');
    adapter.accountId = accountId;
    const raw = evaluateQuota(snapshot, this.config, this.now());
    let state = 'unknown';
    if (raw.fiveHour.state === 'low') state = 'paused';
    else if (raw.fiveHour.state === 'available' && raw.usageAllowed) state = 'running';
    const episodes = this.store.data.pauseEpisodes ??= {};
    const accountKey = createHash('sha256').update(accountId).digest('hex');
    const episode = advanceLowEpisode(episodes[accountKey], raw.fiveHour);
    if (episode) episodes[accountKey] = episode;
    else delete episodes[accountKey];
    const policy = {...raw, state, episodeId: episode?.id};
    this.quotas.set(accountId, policy);
    return policy;
  }
  invalidateAdapter(adapter) { adapter.revision = (adapter.revision || 0) + 1; adapter.accountId = null; }
  status() {
    const { jobs, lastError } = this.store.data;
    return { enabled: this.config.enabled, config: this.config, bridges: [...this.adapters.entries()].map(([id, a]) => ({ id, ready: a.ready, accountId: a.accountId ?? null })),
      accounts: [...this.quotas.entries()].map(([accountId, quota]) => ({ accountId, ...quota })),
      pendingCount: jobs.filter(j => WAITING.has(j.state)).length,
      jobs: jobs.filter(j => !['done', 'canceled', 'proposed'].includes(j.state)).map(({ id, threadId, accountId, kind, state, reason, createdAt }) => ({ id, threadId, accountId, kind, state, reason, createdAt })),
      lastError, updatedAt: this.now() };
  }
  configure(patch) {
    const next = { ...this.config, ...patch };
    this.store.data.config = validateConfig(next); this.quotas.clear(); this.changed(); return this.status();
  }
  cancel(id) {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (!job) throw new Error('未找到待恢复任务');
    if (job.state === 'dispatching') throw new Error('任务正在派发，请在原聊天停止');
    job.state = 'canceled'; this.changed(); return this.status();
  }
  cancelThread(threadId, accountId) {
    for (const j of this.store.data.jobs) if (j.threadId === threadId && j.accountId === accountId && WAITING.has(j.state)) j.state = 'canceled';
    this.changed();
  }
  capture(adapter, message, state = 'pending') {
    const accountId = adapter.accountId;
    if (!accountId) throw new Error('尚未确认账号，未保存待执行请求；请稍后重试');
    const params = structuredClone(message.params || {});
    if (!params.threadId) throw new Error('无法为没有聊天标识的请求排队，请在额度恢复后重试');
    const key = params.clientUserMessageId || `${message.method}:${JSON.stringify(params)}`;
    const existing = this.store.data.jobs.find(j => j.accountId === accountId && j.threadId === params.threadId && j.key === key && !['done', 'canceled'].includes(j.state));
    if (existing) return existing;
    // Compaction can be repeated explicitly, but never manufacture an empty user prompt.
    const job = { id: randomUUID(), accountId, engineKey: adapter.engineKey, adapterId: adapter.id, threadId: params.threadId,
      kind: 'request', method: message.method, params, key, state, createdAt: this.now() };
    const policy = this.policy(accountId);
    if (policy.state === 'paused') {
      const {remainingPercent, resetsAt, limitId} = policy.fiveHour;
      const alert = {at: job.createdAt, remainingPercent, resetsAt, limitId, episodeId: policy.episodeId};
      if (state === 'proposed') job.proposedPauseAlert = alert;
      else job.pauseAlert = alert;
    }
    this.store.data.jobs.push(job); this.changed(); return job;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const adapter of this.adapters.values()) {
        if (!adapter.ready) continue;
        try {
          const revision = adapter.revision || 0;
          const snapshot = await adapter.call('account/rateLimits/read');
          if (revision !== (adapter.revision || 0)) continue;
          this.applySnapshot(adapter, snapshot); this.store.data.lastError = null;
        } catch (error) {
          if (adapter.accountId) this.quotas.delete(adapter.accountId);
          this.store.data.lastError = `额度检查失败：${error.message}`;
        }
      }
      if (this.config.enabled) {
        await this.pauseActive();
        await this.resumePending();
      }
      this.changed();
    } finally { this.busy = false; }
  }
  async pauseActive() {
    for (const adapter of this.adapters.values()) {
      if (!adapter.ready || !adapter.accountId || this.policy(adapter.accountId).state !== 'paused') continue;
      let threads;const observedAt=this.now();
      try { threads = await adapter.listActive(); } catch (error) { this.store.data.lastError = `任务检查失败：${error.message}`; continue; }
      for (const thread of threads) {
        const policy = this.policy(adapter.accountId);
        if (!this.config.enabled || !this.adapters.has(adapter.id) || policy.state !== 'paused') break;
        if (!thread.turnId) continue;
        let job = this.store.data.jobs.find(j => j.accountId === adapter.accountId && j.threadId === thread.id && j.turnId === thread.turnId && !['done', 'canceled'].includes(j.state));
        if (!job) {
          job = { id: randomUUID(), accountId: adapter.accountId, engineKey: adapter.engineKey, adapterId: adapter.id,
            threadId: thread.id, turnId: thread.turnId, kind: 'continue', state: 'interrupting', createdAt: observedAt,
            approvalWaiting: thread.approvalWaiting, child: thread.child };
          this.store.data.jobs.push(job); this.changed();
        }
        if (job.state !== 'interrupting') continue;
        try {
          await adapter.call('turn/interrupt', { threadId: thread.id, turnId: thread.turnId });
          if (job.state !== 'interrupting') continue;
          const {remainingPercent, resetsAt, limitId} = policy.fiveHour;
          job.pauseAlert = {at: this.now(), remainingPercent, resetsAt, limitId, episodeId: policy.episodeId};
          job.state = 'pending'; this.changed();
        } catch (error) { job.reason = `中断待确认：${error.message}`; this.changed(); }
      }
    }
  }
  async resumePending() {
    const threadsSeen = new Set();
    // Start each chat concurrently, with one outstanding submission per chat.
    await Promise.all(this.store.data.jobs.filter(j => WAITING.has(j.state)).map(async job => {
      const key = `${job.accountId}:${job.threadId}`;
      if (threadsSeen.has(key)) return;
      threadsSeen.add(key);
      if (this.policy(job.accountId).state !== 'running') return;
      try {
        const candidates = [...this.adapters.values()].filter(a => a.ready && a.accountId === job.accountId && a.engineKey === job.engineKey);
        let adapter = candidates.find(a => a.id === job.adapterId);
        if (!adapter) {
          for (const candidate of candidates) if (await candidate.hasLoaded?.(job.threadId)) { adapter = candidate; break; }
        }
        adapter ||= candidates[0];
        if (!adapter) return;
        const info = await adapter.inspect(job.threadId);
        if (!WAITING.has(job.state)) return;
        if (info.archived) { job.state = 'canceled'; return; }
        if (info.active || info.approvalWaiting) return;
        if (job.kind === 'continue') {
          const latest = info.latestTurn;
          if (!latest || latest.id !== job.turnId || latest.status !== 'interrupted') { job.state = 'canceled'; return; }
          if (job.approvalWaiting) {
            job.state = 'attention'; job.reason = '原任务等待审批，请在原聊天确认后继续'; return;
          }
        }
        // Check again after awaits: a new quota notification can close the gate.
        if (this.policy(job.accountId).state !== 'running' || !this.config.enabled) return;
        await adapter.ensureLoaded(job.threadId);
        if (!WAITING.has(job.state) || !this.config.enabled || this.policy(job.accountId).state !== 'running') return;
        job.state = 'dispatching'; this.changed();
        const params = job.kind === 'continue' ? { threadId: job.threadId, clientUserMessageId: job.id,
          input: [{ type: 'text', text: '额度已恢复。请从上次被额度守卫中断的位置继续完成原任务；先核对已完成的操作，避免重复执行。已有子任务由守卫在原聊天续跑，请先检查原子任务状态，不重复创建。保留当前模型、权限和协作模式，仍需用户决定的事项请继续等待用户。' }] } : structuredClone(job.params);
        if (['turn/steer', 'turn/addUserMessage'].includes(job.method)) delete params.expectedTurnId;
        const method = job.kind === 'continue' ? 'turn/start' : ['turn/steer', 'turn/addUserMessage'].includes(job.method) ? 'turn/start' : job.method;
        const result = await adapter.call(method, params, 30_000);
        job.state = 'done'; job.result = result; job.resumedTurnId = result?.turn?.id ?? result?.turnId ?? null;
        this.changed();
      } catch (error) {
        if (job.state === 'dispatching') { job.state = 'attention'; job.reason = `续跑结果未确认，请检查原聊天：${error.message}`; }
        else if (error.data?.errorType === 'thread_archived' || /(?:thread|session).*archived|thread not found/i.test(error.message)) { job.state = 'canceled'; job.reason = '聊天已归档或删除'; }
        else job.reason = `等待恢复：${error.message}`;
      }
    }));
  }
}
