// Offline dependency checks for the live probes. No binary or model is called.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(root, 'bridge.mjs'), 'utf8').split('\n');
const url = (file) => JSON.stringify(pathToFileURL(path.join(root, file)).href);
const grab = (name, kind = 'function') => {
  const pattern = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((line) => pattern.test(line));
  assert.ok(start >= 0, name);
  const lines = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    if (/^\S/.test(SRC[i])) {
      if (/^[}\])]/.test(SRC[i])) lines.push(SRC[i]);
      break;
    }
    lines.push(SRC[i]);
  }
  return lines.join('\n');
};
let passed = 0;
for (const file of ['codex-chat-probe.mjs', 'codex-appserver-probe.mjs']) {
  const source = readFileSync(path.join(root, 'scripts/probes', file), 'utf8');
  // Evaluate only the harness template. The probe's outer script, scratch
  // setup and live test scenarios are never evaluated.
  const template = file === 'codex-chat-probe.mjs'
    ? source.slice(source.indexOf('const HARNESS ='), source.indexOf('\nconst B =')).replace('const HARNESS =', 'return')
    : `return ${source.slice(source.indexOf('        `') + 8, source.indexOf('\n`,\n        grab(') + 2)};`;
  let harness = new Function('url', 'TMP', 'RUNS', template)(url, root, root);
  // Refuse a spawn even if a future edit moves the checked dependency later.
  harness = harness
    .replace(/import \{ spawnWorker \} from [^;]+;/, 'const spawnWorker = () => { throw new Error("OFFLINE SPAWN REFUSED"); };')
    .replace(/import \{ spawn as spawnProcess \} from [^;]+;/, 'const spawnProcess = () => { throw new Error("OFFLINE SPAWN REFUSED"); };');
  const checks = `
    export const DEPENDENCIES = { codexWritingPrompt, codexWorkerContext, retryCodexOnClaude };
    export const exerciseSpawn = ${file === 'codex-chat-probe.mjs'
      ? '() => codexWorkerContext(process.env).env'
      : '() => startAppServerChild()'};
  `;
  const assembled = [harness, ...(file === 'codex-appserver-probe.mjs' ? [grab('APP_SERVER_CALL_TIMEOUT_MS', 'const'), grab('startAppServerChild')] : []), checks].join('\n');
  const module = await import(`data:text/javascript,${encodeURIComponent(assembled)}`);
  assert.ok(module.DEPENDENCIES.codexWritingPrompt('criteria').endsWith('criteria'));
  assert.equal(module.DEPENDENCIES.codexWorkerContext({}).env.LEASH_LANE, 'chat');
  assert.equal(module.DEPENDENCIES.retryCodexOnClaude(), false);
  if (file === 'codex-appserver-probe.mjs') await assert.rejects(module.exerciseSpawn(), /OFFLINE SPAWN REFUSED/);
  else assert.equal(module.exerciseSpawn().LEASH_LANE, 'chat');
  const missing = assembled.replace(/import \{ codexWorkerContext \} from [^;]+;/, '');
  await assert.rejects(import(`data:text/javascript,${encodeURIComponent(missing)}`), /codexWorkerContext is not defined/);
  passed += 5;
}
process.stdout.write(`${passed} passed, 0 failed\n`);
