import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/client.mjs';
const files = fs.readdirSync(path.join(ROOT, 'test')).filter(name => name.endsWith('.test.mjs')).map(name => path.join(ROOT, 'test', name));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
