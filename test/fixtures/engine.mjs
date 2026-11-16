import readline from 'node:readline';
const threads = new Map(); let used = 10; let ordinaryUsageAllowed = true; let sequence = 0;
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function result(id, value) { send({ id, result: value }); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line); const p = m.params || {};
  if (!m.method || m.id === undefined) return;
  if (!Object.hasOwn(m, 'params')) { send({ id: m.id, error: { code: -32600, message: 'missing field params' } }); return; }
  switch (m.method) {
    case 'initialize': result(m.id, { userAgent: 'test-engine', codexHome: 'isolated-fixture' }); break;
    case 'account/rateLimits/read': result(m.id, { accountId: 'fixture-account', ordinaryUsageAllowed, rateLimits: { primary: { usedPercent: used, resetsAt: Math.floor(Date.now() / 1000) + 600 }, secondary: null } }); break;
    case 'thread/start': { const id = p.id || `thread-${++sequence}`; threads.set(id, { id, status: { type: 'idle' }, turns: [], source: 'cli' }); result(m.id, { thread: threads.get(id) }); break; }
    case 'thread/loaded/list': result(m.id, { data: [...threads.keys()] }); break;
    case 'thread/read': { const thread = threads.get(p.threadId); if (thread) result(m.id, { thread }); else send({ id: m.id, error: { code: -32000, message: 'not found' } }); break; }
    case 'thread/turns/list': result(m.id, { data: [...(threads.get(p.threadId)?.turns || [])].reverse().slice(0, p.limit || 20), nextCursor: null }); break;
    case 'thread/resume': result(m.id, { thread: threads.get(p.threadId) }); break;
    case 'turn/start': {
      const thread = threads.get(p.threadId); const turn = { id: `turn-${++sequence}`, status: 'inProgress' };
      thread.turns.push(turn); thread.status = { type: 'active', activeFlags: [] };
      result(m.id, { turn }); send({ method: 'turn/started', params: { threadId: p.threadId, turn } }); break;
    }
    case 'turn/interrupt': {
      const thread = threads.get(p.threadId); const turn = thread.turns.at(-1);
      turn.status = 'interrupted'; thread.status = { type: 'idle' };
      result(m.id, {}); send({ method: 'turn/completed', params: { threadId: p.threadId, turn } }); break;
    }
    case 'fixture/usage': used = p.used; ordinaryUsageAllowed = p.allowed ?? true; result(m.id, {}); send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: used } } } }); break;
    case 'fixture/complete': { const thread = threads.get(p.threadId); thread.turns.at(-1).status = 'completed'; thread.status = { type: 'idle' }; result(m.id, {}); send({ method: 'turn/completed', params: { threadId: p.threadId, turn: thread.turns.at(-1) } }); break; }
    case 'fixture/echo': result(m.id, p); break;
    default: send({ id: m.id, error: { code: -32601, message: `Unsupported fixture method ${m.method}` } });
  }
});
