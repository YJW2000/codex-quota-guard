import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Controller } from '../src/controller.mjs';
export function usage(primary = 10, secondary = 20, accountId = 'account-a') {
  return { accountId, ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: primary, resetsAt: 2000, windowDurationMins: 300 }, secondary: { usedPercent: secondary, resetsAt: 3000, windowDurationMins: 10080 } } };
}
export function fixture(t) {
  const home = testHome();
  t.after(() => cleanHome(home));
  const store = new Store(home); const controller = new Controller(store);
  const adapter = new FakeAdapter(); controller.addAdapter('one', adapter);
  return { home, store, controller, adapter };
}
const testRoot = fileURLToPath(new URL('../.cache/tests/', import.meta.url));
export function testHome() { fs.mkdirSync(testRoot, { recursive: true }); return fs.mkdtempSync(path.join(testRoot, 'run-')); }
export function cleanHome(home) {
  const resolved = path.resolve(home); const root = path.resolve(testRoot);
  if (!resolved.startsWith(root + path.sep) || path.relative(root, resolved).includes('..')) throw new Error('Unsafe test cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
export class FakeAdapter {
  constructor() { this.ready = true; this.accountId = 'account-a'; this.engineKey = 'local'; this.snapshot = usage(); this.threads = new Map(); this.calls = []; }
  thread(id, extra = {}) { this.threads.set(id, { id, active: true, latestTurn: { id: `turn-${id}`, status: 'inProgress' }, ...extra }); return this; }
  async listActive() { return [...this.threads.values()].filter(t => t.active).map(t => ({ id: t.id, turnId: t.latestTurn.id, approvalWaiting: t.approvalWaiting, child: t.child })); }
  async inspect(id) { const t = this.threads.get(id); if (!t) throw new Error('not found'); return structuredClone(t); }
  async ensureLoaded() {}
  async hasLoaded(id) { return this.threads.has(id); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/rateLimits/read') { if (this.failQuota) throw new Error('offline'); return structuredClone(this.snapshot); }
    if (method === 'turn/interrupt') {
      if (this.failInterrupt) throw new Error('timeout');
      const t = this.threads.get(params.threadId); t.active = false; t.latestTurn.status = 'interrupted'; return {};
    }
    if (this.failStart) throw new Error('response lost');
    const t = this.threads.get(params.threadId); t.active = true; t.latestTurn = { id: `resumed-${this.calls.length}`, status: 'inProgress' };
    return { turn: t.latestTurn };
  }
}
