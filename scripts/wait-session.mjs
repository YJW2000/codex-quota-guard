import {setTimeout as delay} from 'node:timers/promises';
import {control} from '../src/client.mjs';

const [sessionId, seconds] = process.argv.slice(2);
const deadline = Date.now() + Number(seconds) * 1000;
let connected = false;
while (Date.now() < deadline) {
  const timeoutMs = Math.max(1, Math.min(800, deadline - Date.now()));
  const result = await control('guard.session', {sessionId}, {timeoutMs});
  if (result.connected === true) {
    connected = true;
    break;
  }
  await delay(250);
}
process.exitCode = connected ? 0 : 1;
