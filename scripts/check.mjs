import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/client.mjs';
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const manifest = read('plugin.json'); const legacy = read('.codex-plugin/plugin.json');
assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(manifest.name, legacy.name); assert.equal(manifest.version, legacy.version);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
const ui = manifest.extensions['com.openai'].interface;
assert.ok([...ui.shortDescription].length <= 30); assert.equal(ui.category, 'Developer Tools');
for (const key of ['logo', 'composerIcon']) assert.ok(fs.existsSync(path.resolve(ROOT, ui[key])));
assert.equal(read('mcp.json').mcpServers['quota-guard'].type, 'stdio');
assert.match(fs.readFileSync(path.join(ROOT, 'skills/quota-guard/SKILL.md'), 'utf8'), /^---\r?\nname: quota-guard\r?\ndescription:/);
for (const dir of ['src', 'scripts', 'test']) {
  for (const file of fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter(p => p.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, dir, file)], { stdio: 'pipe', windowsHide: true });
  }
}
console.log('Plugin manifests, referenced files and JavaScript syntax verified.');
