import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite} from './store.mjs';

function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// A service can omit a reset time. Remember the same low episode until a
// measured recovery or a different known reset, including across restarts.
export function advanceLowEpisode(previous, window) {
  if (window?.state === 'available') return previous?.active ? {...previous, active: false} : previous;
  if (window?.state !== 'low') return previous;
  const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null;
  if (previous && reset !== null && previous.reset === reset) {
    return previous.active ? previous : {...previous, active: true};
  }
  if (previous?.active && reset === null) return previous;
  if (previous?.active && previous.reset === null) return {...previous, reset};
  return {id: reset === null ? randomUUID() : 'reset-' + reset, reset, active: true};
}

export function createAlertCollector(home, outbox) {
  const file = path.join(home, 'weekly-alert-windows.json');
  let weekly = {accounts:{}, pending:{}}, readError = null, weeklyError = null, pauseError = null;
  const queuedPauses = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts) ||
        Object.values(data.accounts).some(e => !e || typeof e.id !== 'string' || !e.id || typeof e.active !== 'boolean' ||
          (e.reset !== null && !Number.isFinite(e.reset))) || !data.pending || typeof data.pending !== 'object' ||
        Array.isArray(data.pending) || Object.values(data.pending).some(p => !p || !Number.isFinite(p.remainingPercent))) {
      throw Error('Invalid weekly notification history');
    }
    weekly = data;
  } catch (error) {
    if (error.code !== 'ENOENT') readError = '周额度提醒记录无法读取，原文件已保留';
  }

  function save(next) {
    atomicWrite(file, {...next, version: 1});
    weekly = next;
  }

  function recordWeekly(status) {
    if (!status?.accountId || !Number.isFinite(status.checkedAt) || status.enabled === false) return;
    const account = hash([status.accountId]);
    const previous = weekly.accounts[account];
    const window = status.weekly;
    const episode = advanceLowEpisode(previous, window);
    if (episode === previous) return;
    const accounts = {...weekly.accounts, [account]: episode};
    const pending = {...weekly.pending};
    if (episode.active && episode.id !== previous?.id) {
      pending[hash([account, episode.id])] = {remainingPercent: window.remainingPercent, resetsAt: window.resetsAt};
    }
    save({accounts, pending});
  }

  function observeQuota(status) {
    if (readError) return;
    try {
      recordWeekly(status);
      // Replay the durable intent after a crash, even when a newer read shows recovery.
      const entries = Object.entries(weekly.pending);
      for (const [key, {remainingPercent, resetsAt}] of entries) {
        outbox.enqueue({kind: 'weekly', key, remainingPercent, resetsAt});
      }
      if (entries.length) save({...weekly, pending: {}});
      weeklyError = null;
    } catch {
      weeklyError = '周额度提醒暂未入队，将在下次额度检查时重试';
    }
  }

  function observeJobs(jobs) {
    try {
      for (const job of jobs) {
        if (job.state === 'proposed' || job.state === 'interrupting') continue;
        const alert = job.pauseAlert;
        if (!alert?.episodeId || !job.accountId) continue;
        const key = hash([job.accountId, alert.episodeId]);
        if (queuedPauses.has(key)) continue;
        outbox.enqueue({kind: 'pause', key, remainingPercent: alert.remainingPercent, resetsAt: alert.resetsAt});
        queuedPauses.add(key);
      }
      pauseError = null;
    } catch {
      pauseError = '五小时暂停提醒暂未入队，将在下次检查时重试';
    }
  }
  return {observeQuota, observeJobs, status: () => ({lastError: readError || weeklyError || pauseError})};
}
