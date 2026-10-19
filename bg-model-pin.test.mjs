#!/usr/bin/env node
// Tripwire: background workers are pinned to BG_MODEL and the chat lane's /model
// setting cannot move them.
//
// History: the bg default was moved to opus on 2026-08-10 after six consecutive
// workers died on the Fable session limit, but the spawn line still read
// `st.model || DEFAULT_MODEL` for every lane, so the moment /model fable was set
// for chat the whole pool followed it (found 2026-09-02: both live workers on
// fable). This test reads the source the same way detached-workers.test.mjs
// does, because importing bridge.mjs boots the daemon.
//
//   node bg-model-pin.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('./bridge.mjs', import.meta.url)), 'utf8');

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

t('BG_MODEL exists, defaults to the configured model, and is overridable via conf(bgModel)', () => {
  ok(/const BG_MODEL = conf\('bgModel', ''\) \|\| DEFAULT_MODEL;/.test(SRC), 'BG_MODEL constant missing or not falling back to the configured model');
});

t('the spawn line routes bg lanes to BG_MODEL and only the chat lane to /model', () => {
  const line = SRC.split('\n').find((l) => l.includes("args.push('--model'"));
  ok(line, 'no --model spawn line found');
  ok(line.includes('selectedModel'), 'spawn must use the prepared model');
  ok(/return lane\.isBg \? BG_MODEL : chatState\(\)\.model \|\| DEFAULT_MODEL/.test(SRC), 'configured background model must come from BG_MODEL');
  ok(SRC.includes('const configured = laneModel(lane)'), 'preparation uses the lane pin');
});

t('lane pin behavior keeps background on Opus when chat selects Fable', () => {
  const lines = SRC.split('\n');
  const start = lines.findIndex(l => l.startsWith('function laneModel('));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  const laneModel = new Function('BG_MODEL', 'DEFAULT_MODEL', 'chatState', 'modelFallbacks', 'LANES', lines.slice(start, end + 1).join('\n') + '; return laneModel;')('opus', 'opus', () => ({ model: 'fable' }), new Map(), { main: {} });
  ok(laneModel({ isBg: true }) === 'opus', 'background must keep its own model');
  ok(laneModel({}) === 'fable', 'chat must use its configured model');
});

t('there is exactly one --model spawn line (no second path that could leak /model into bg)', () => {
  const n = SRC.split('\n').filter((l) => l.includes("args.push('--model'")).length;
  ok(n === 1, `expected 1 --model spawn line, found ${n}`);
});

t('a bg run finishing does not overwrite the chat lane lastModel', () => {
  ok(/if \(run\.model && lane === LANES\.main\) st\.lastModel = run\.model;/.test(SRC), 'lastModel write is not guarded to the main lane');
});

t('bg lanes are marked isBg (the flag the spawn line keys on)', () => {
  ok(/isBg: true,/.test(SRC), 'makeBgLane does not set isBg: true');
  ok(!/main: \{[^}]*isBg: true/.test(SRC), 'the main lane must not carry isBg');
});

t('/model help tells the user bg workers are not affected', () => {
  ok(/background workers: always \$\{BG_MODEL \|\| 'the CLI default'\} \(not affected by \/model\)/.test(SRC), '/model readout does not mention the bg pin');
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n` + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✅ ${pass}/${pass} bg-model-pin tests pass`);
