import { Peer } from './rpc.mjs';
import { control } from './client.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'guard_status', description: '读取本机额度守卫状态、额度窗口和待恢复任务。', inputSchema: object({}), annotations: { readOnlyHint: true }, command: 'status' },
  { name: 'guard_enable', description: '启用额度守卫；确认真实额度充足后自动恢复原队列。', inputSchema: object({}), command: 'enable' },
  { name: 'guard_disable', description: '关闭额度接管并释放防睡眠；保留待恢复队列，不自动启动其中任务。', inputSchema: object({}), command: 'disable' },
  { name: 'guard_check_now', description: '立即读取真实额度并执行符合条件的暂停或恢复。', inputSchema: object({}), command: 'check' },
  { name: 'guard_configure', description: '修改额度预留百分比或等待时防睡眠设置。', inputSchema: object({ reservePercent: { type: 'number', minimum: 1, maximum: 50 }, preventSleep: { type: 'boolean' } }), command: 'configure' },
  { name: 'guard_cancel_pending', description: '取消一条额度守卫待恢复记录；不会停止已派发任务。', inputSchema: { ...object({ id: { type: 'string', minLength: 1 } }), required: ['id'] }, command: 'cancel' },
];
export function serveMcp(input = process.stdin, output = process.stdout) {
  const peer = new Peer(input, output);
  peer.on('message', async request => {
    try {
      if (request.id === undefined) return;
      if (request.method === 'initialize') peer.reply(request, { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-quota-guard', version: '0.1.0' } });
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
