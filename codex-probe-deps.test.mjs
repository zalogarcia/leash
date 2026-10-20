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

// THE CHAT PROBE'S REAL MODULE, called up to the spawn. Its own slice list is
// read out of the probe, assembled over a scratch directory with the spawn
// refused, and runCodex is called: a free identifier on that path fails here,
// offline, instead of on the probe's first live turn (WRITE_GRANT_ENV,
// independent review 2026-10-13). The refused spawn is the expected ending.
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const source = readFileSync(path.join(root, 'scripts/probes/codex-chat-probe.mjs'), 'utf8');
  const template = source.slice(source.indexOf('const HARNESS ='), source.indexOf('\nconst B =')).replace('const HARNESS =', 'return');
  const tmp = mkdtempSync(path.join(tmpdir(), 'codex-probe-deps-'));
  try {
    const harness = new Function('url', 'TMP', 'RUNS', template)(url, tmp, path.join(tmp, 'runs'))
      .replace(/import \{ spawnWorker \} from [^;]+;/, 'const spawnWorker = () => { throw new Error("OFFLINE SPAWN REFUSED"); };');
    const open = source.indexOf('[\n        HARNESS,');
    const close = source.indexOf("].join('\\n'),", open);
    assert.ok(open > 0 && close > open, 'the probe still assembles its module from a [HARNESS, grab(...)] list');
    const list = new Function('HARNESS', 'grab', `return ${source.slice(open, close + 1)};`)(harness, grab);
    const B = await import(`data:text/javascript,${encodeURIComponent(list.join('\n'))}`);
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' ')); // the refused launch is logged; keep the output to the count line
    try {
      B.runCodex('probe deps: reach the spawn', {});
    } finally {
      console.error = realError;
    }
    assert.equal(B.REPORTED.length, 1, 'runCodex reported one outcome');
    assert.match(B.REPORTED[0].outcome.answer, /OFFLINE SPAWN REFUSED/, 'runCodex reached the spawn');
    passed += 2;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.stdout.write(`${passed} passed, 0 failed\n`);
