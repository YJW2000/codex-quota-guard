import { Peer } from './rpc.mjs';
import { control } from './client.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'guard_status', description: '读取独立监控的真实额度；失败显示暂不可用。', inputSchema: object({}), annotations: { readOnlyHint: true }, command: 'status' },
  { name: 'guard_enable', description: '启用独立监控的轮询；不影响 Codex 任务。', inputSchema: object({}), command: 'enable' },
  { name: 'guard_disable', description: '关闭独立监控轮询；不影响 Codex。', inputSchema: object({}), command: 'disable' },
  { name: 'guard_check_now', description: '立即只读查询额度。', inputSchema: object({}), command: 'check' },
  { name: 'guard_configure', description: '修改额度提醒阈值。', inputSchema: object({ reservePercent: { type: 'number', minimum: 1, maximum: 50 } }), command: 'configure' },
];
export function serveMcp(input = process.stdin, output = process.stdout) {
  const peer = new Peer(input, output);
  peer.on('message', async request => {
    try {
      if (request.id === undefined) return;
      if (request.method === 'initialize') peer.reply(request, { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-quota-guard', version: '0.2.0' } });
      else if (request.method === 'ping') peer.reply(request, {});
      else if (request.method === 'tools/list') peer.reply(request, { tools: tools.map(({ command, ...tool }) => tool) });
      else if (request.method === 'tools/call') {
        const tool = tools.find(t => t.name === request.params?.name);
        if (!tool) throw new Error('Unknown tool');
        const args = request.params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args) || args === null) throw new Error('Arguments must be an object');
        for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`Unknown argument: ${key}`);
        if (tool.command === 'cancel' && (typeof args.id !== 'string' || !args.id)) throw new Error('id is required');
        try {
          const result = await control(tool.command, args);
          peer.reply(request, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
        } catch (error) { peer.reply(request, { isError: true, content: [{ type: 'text', text: error.message }] }); }
      } else peer.reject(request, Object.assign(new Error('Method not found'), { code: -32601 }));
    } catch (error) { peer.reject(request, error); }
  });
  return peer;
}
