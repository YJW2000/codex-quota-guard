import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const MAX_LINE = 32 * 1024 * 1024;
export class Peer extends EventEmitter {
  constructor(input, output = input) {
    super(); this.output = output; this.pending = new Map(); this.prefix = `qg:${randomUUID()}:`; this.seq = 0;
    this.closed = false; let buffered = '';
    input.setEncoding('utf8');
    input.on('data', chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_LINE && !buffered.includes('\n')) return this.fail(new Error('RPC line too large'));
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_LINE) return this.fail(new Error('RPC line too large'));
        try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
      }
    });
    input.on('error', error => this.fail(error));
    output.on('error', error => this.fail(error));
    input.on('end', () => this.fail(new Error('RPC connection closed')));
    input.on('close', () => this.fail(new Error('RPC connection closed')));
  }
  receive(message) {
    if (message.method) { this.emit('message', message); return; }
    const pending = this.pending.get(message.id);
    if (!pending) { this.emit('message', message); return; }
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'RPC error'), { code: message.error.code, data: message.error.data }));
    else pending.resolve(message.result);
  }
  send(message) {
    if (this.closed) throw new Error('RPC connection closed');
    this.output.write(`${JSON.stringify(message)}\n`);
  }
  call(method, params, timeout = 15_000) {
    const id = `${this.prefix}${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params: params ?? {} }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(request, result) { if (request.id !== undefined) this.send({ id: request.id, result }); }
  reject(request, error) { if (request.id !== undefined) this.send({ id: request.id, error: { code: typeof error.code === 'number' ? error.code : -32000, message: error.message, ...(error.data ? { data: error.data } : {}) } }); }
  fail(error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
}
