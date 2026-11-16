import { spawn, execFileSync } from 'node:child_process';
import { Peer } from '../src/rpc.mjs';

const args = process.argv.slice(2);
const get = flag => args[args.indexOf(flag) + 1];
const binary = args.includes('--backend') ? get('--backend') : args.includes('--bridge') ? get('--bridge') : process.env.CODEX_APP_RUNTIME_CLI_PATH;
if (!binary) throw new Error('Pass --backend <codex.exe> or --bridge <launcher.exe>');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
const child = spawn(binary, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const peer = new Peer(child.stdout, child.stdin);
let diagnostic = '';
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
try {
  const initialized = await peer.call('initialize', { clientInfo: { name: 'codex_quota_guard_doctor', title: 'Quota Guard diagnostics', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 30_000);
  peer.send({ method: 'initialized' });
  const usage = await peer.call('account/rateLimits/read', undefined, 30_000);
  const loaded = await peer.call('thread/loaded/list', undefined);
  if (!usage.accountId || typeof usage.ordinaryUsageAllowed !== 'boolean' || !Array.isArray(loaded.data)) throw new Error('Required quota/account/thread fields are unavailable');
  const windows = Object.values(usage.rateLimitsByLimitId || { codex: usage.rateLimits }).flatMap(bucket => ['primary', 'secondary'].filter(key => bucket?.[key]).map(key => ({ remainingPercent: 100 - bucket[key].usedPercent, resetsAt: bucket[key].resetsAt })));
  console.log(JSON.stringify({ compatible: true, version, initialized: Boolean(initialized), usageReadable: true, ordinaryUsageAllowed: usage.ordinaryUsageAllowed, windows, loadedThreads: loaded.data.length }));
} catch (error) {
  console.error(JSON.stringify({ compatible: false, version, error: error.message }));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 3000); timer.unref(); child.once('exit', () => clearTimeout(timer));
}
