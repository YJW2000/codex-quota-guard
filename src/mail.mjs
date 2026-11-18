import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.mjs';

function formatMessage(record) {
  const pause = record.kind === 'pause';
  const subject = pause ? 'Codex 额度守卫 · 5 小时额度触发暂停' : 'Codex 额度守卫 · 周额度即将耗尽';
  const lines = [pause ? '守卫已因 5 小时额度偏低暂停或暂缓对话。' : '周额度已达到提醒阈值。守卫仅发送提醒，按服务实际可用额度继续执行。'];
  if (record.remainingPercent != null) lines.push(`触发时剩余：${record.remainingPercent}%`);
  if (record.resetsAt) lines.push(`服务报告的重置时间：${new Date(record.resetsAt * 1000).toLocaleString('zh-CN')}`);
  lines.push(`记录时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`);
  return { subject, body: lines.join('\r\n'), id: record.id };
}

// The named-pipe daemon is the sole writer. Persist each phase before/after sending
// so a crash after provider acceptance can never silently replay the same notice.
export function createMailOutbox(home, {
  send,
  isConfigured = () => typeof send === 'function',
  now = Date.now
} = {}) {
  const file = path.join(home, 'mail-outbox.json');
  let records = [], readError = null, running = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.records) ||
        saved.records.some(r => !r || typeof r.id !== 'string' ||
          !['pause','weekly'].includes(r.kind) || !['pending','sending','attention','sent'].includes(r.state))) {
      throw Error('Unknown mail ledger format');
    }
    records = saved.records.map(r => r.state === 'sending'
      ? { ...r, state: 'attention', error: '上次发信进程退出，结果有待核对' } : r);
  } catch (error) {
    if (error.code !== 'ENOENT') readError = '邮件队列文件无法读取，原文件已保留';
  }

  function persist(next) {
    if (readError) throw Error(readError);
    atomicWrite(file, { version: 1, records: next });
    records = next;
  }

  function update(id, patch) {
    persist(records.map(r => r.id === id ? { ...r, ...patch } : r));
  }

  function enqueue(event) {
    if (readError) throw Error(readError);
    const { kind, key, remainingPercent, resetsAt } = event;
    if (!['pause','weekly'].includes(kind) || typeof key !== 'string' || !key) throw Error('Invalid mail event');
    const id = createHash('sha256').update(kind+'\0'+key).digest('hex');
    if (records.some(r => r.id === id)) return false;
    const createdAt = now();
    persist([...records, { id, kind, createdAt, state: 'pending', attempts: 0, nextTry: createdAt,
      remainingPercent: Number.isFinite(remainingPercent) && remainingPercent>=0 && remainingPercent<=100 ? remainingPercent : null,
      resetsAt: Number.isFinite(resetsAt) && resetsAt>0 && resetsAt<1e11 ? resetsAt : null }]);
    return true;
  }

  async function processPending() {
    for (const item of records.filter(r => r.state === 'pending' && r.nextTry <= now())) {
      const attempts = item.attempts + 1;
      update(item.id, { state: 'sending', attempts });
      try {
        await send(formatMessage(item));
      } catch (error) {
        const uncertain = error.uncertain === true;
        update(item.id, { state: uncertain ? 'attention' : 'pending',
          error: uncertain ? '邮件投递结果待核对' : '邮件发送失败，等待重试',
          nextTry: now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts-1, 7)) });
        continue;
      }
      update(item.id, { state: 'sent', sentAt: now(), error: null });
    }
  }

  function flush() {
    if (readError || !isConfigured()) return Promise.resolve();
    running ??= processPending().finally(() => { running = null; });
    return running;
  }

  function status() {
    const configured = isConfigured();
    return { configured, pending: records.filter(r => r.state === 'pending' || r.state === 'sending').length,
      sent: records.filter(r => r.state === 'sent').length,
      attention: records.filter(r => r.state === 'attention').length,
      lastSentAt: records.reduce((latest,r) => Math.max(latest,r.sentAt || 0),0) || null,
      lastError: readError || records.findLast(r => r.error)?.error || (!configured ? '等待连接发信邮箱' : null) };
  }

  return { enqueue, flush, status };
}
