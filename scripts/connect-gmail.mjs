import {createGmailTransport} from '../src/gmail.mjs';
import {installation} from '../src/client.mjs';
import {stateDirectory} from '../src/store.mjs';
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--recipient')) {
    throw Error('用法：node scripts/connect-gmail.mjs [--recipient 单个收件邮箱]');
  }
  const mail = createGmailTransport(stateDirectory(), installation().backendPath);
  console.log(JSON.stringify(await mail.bind(args[1])));
} catch (error) {
  console.error('连接 Gmail 失败：' + error.message);
  process.exitCode = 1;
}
