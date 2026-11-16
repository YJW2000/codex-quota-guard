import { runDaemon } from './daemon.mjs';
import { runBridge } from './bridge.mjs';
import { control } from './client.mjs';
import { serveMcp } from './mcp.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
try {
  if (command === 'daemon') await runDaemon();
  else if (command === 'mcp') serveMcp();
  else if (command === 'bridge') await runBridge(args[0] === '--' ? args.slice(1) : args);
  else if (['status', 'check', 'enable', 'disable', 'cancel', 'configure', 'shutdown'].includes(command)) {
    const params = command === 'cancel' ? { id: args[0] } : command === 'configure' ? JSON.parse(args.join(' ') || '{}') : {};
    const result = await control(command, params, { start: command !== 'shutdown' && !args.includes('--no-start') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  // Never log protocol payloads, prompts, or login credentials.
  process.stderr.write(`[quota-guard] ${error.message}\n`); process.exitCode = 1;
}
