import {createGmailTransport} from '../src/gmail.mjs';
import {installation} from '../src/client.mjs';
import {stateDirectory} from '../src/store.mjs';
try {
  const mail = createGmailTransport(stateDirectory(), installation().backendPath);
  console.log(JSON.stringify(await mail.bind()));
} catch (error) {
  console.error('连接 Gmail 失败：' + error.message);
  process.exitCode = 1;
}
