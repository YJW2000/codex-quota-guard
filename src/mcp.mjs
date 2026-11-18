import { Peer } from './rpc.mjs';
import { control } from './client.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'guard_status', description: '读取独立监控的真实额度；失败显示暂不可用。', inputSchema: object({}), annotations: { readOnlyHint: true }, command: 'status' },
  { name: 'guard_enable', description: '启用额度轮询与已连接引擎的自动控制；不会接管普通桌面启动。', inputSchema: object({}), command: 'enable' },
  { name: 'guard_disable', description: '关闭轮询与自动控制，保留队列并释放防睡眠。', inputSchema: object({}), command: 'disable' },
  { name: 'guard_check_now', description: '立即查询真实额度，并检查已连接引擎的暂停或恢复。', inputSchema: object({}), command: 'check' },
  { name: 'guard_automation_status', description: '查看已连接任务引擎、自动停跑恢复队列和降级原因。', inputSchema: object({}), command: 'guard.status' },
  { name: 'guard_safe_mode', description: '一键退出自动控制，保留监控与队列，让连接的桌面正常运行。', inputSchema: object({}), command: 'guard.safeMode' },
  { name: 'guard_cancel_pending', description: '取消一条挂起任务，避免自动继续。', inputSchema: {...object({id:{type: "string"}}),required:["id"]}, command: 'guard.cancelJob' },
  { name: 'guard_configure', description: '修改额度预留阈值或等待时防睡眠设置。', inputSchema: object({ reservePercent: { type: 'number', minimum: 1, maximum: 50 }, preventSleep:{type:'boolean'} }), command: 'configure' },
];
export function serveMcp(input = process.stdin, output = process.stdout) {
  const peer = new Peer(input, output);
  peer.on('message', async request => {
    try {
      if (request.id === undefined) return;
      if (request.method === 'initialize') peer.reply(request, { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-quota-guard', version: '0.4.0' } });
      else if (request.method === 'ping') peer.reply(request, {});
      else if (request.method === 'tools/list') peer.reply(request, { tools: tools.map(({ command, ...tool }) => tool) });
      else if (request.method === 'tools/call') {
        const tool = tools.find(t => t.name === request.params?.name);
        if (!tool) throw new Error('Unknown tool');
        const args = request.params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args) || args === null) throw new Error('Arguments must be an object');
        for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`Unknown argument: ${key}`);
        if (tool.command === 'guard.cancelJob' && (typeof args.id !== 'string' || !args.id)) throw new Error('id is required');
        try {
          const result = await control(tool.command, args);
          peer.reply(request, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
        } catch (error) { peer.reply(request, { isError: true, content: [{ type: 'text', text: error.message }] }); }
      } else peer.reject(request, Object.assign(new Error('Method not found'), { code: -32601 }));
    } catch (error) { peer.reject(request, error); }
  });
  return peer;
}
