#!/usr/bin/env node
// Tests for schedule-script.mjs, a schedule entry that runs a script, and its
// wiring into bridge.mjs (read as text, never imported: importing the daemon
// boots a second one). The real checkSchedules runs these entries in
// schedule-claude-only.test.mjs, section 6c.
//
//   node schedule-script.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduledScriptPrompt, scriptCommand, SCRIPT_OUTPUT_MAX } from './schedule-script.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
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
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

t('scriptCommand runs .mjs with node and anything else directly', () => {
  eq(scriptCommand('/a/sweep.mjs', '/n/node'), ['/n/node', ['/a/sweep.mjs']]);
  eq(scriptCommand('/a/sweep.sh', '/n/node'), ['/a/sweep.sh', []]);
});

t('no output, no turn', () => {
  eq(scheduledScriptPrompt({ item: { id: 7, script: '/a/s.mjs', text: 'x' }, output: '  \n' }), null);
});

t('the turn is framed as the daemon\'s, entry text first, output whole', () => {
  const p = scheduledScriptPrompt({ item: { id: 7, script: '/a/sweep.mjs', text: 'Sweep: act on each line.' }, output: 'Item 12 · queued 5h · no worker\n', ownerName: 'Alex' });
  const lines = p.split('\n');
  eq(lines[0], '[Scheduled script, daemon authored, not Alex.]');
  ok(lines[1].includes('#7') && lines[1].includes('sweep.mjs'), lines[1]);
  eq(lines[2], 'Sweep: act on each line.');
  ok(p.endsWith('Item 12 · queued 5h · no worker'), p);
  ok(!/[–—]/.test(p), 'no em or en dash');
});

t('with no name configured the frame says the owner', () => {
  const p = scheduledScriptPrompt({ item: { id: 7, script: '/a/s.mjs', text: 'x' }, output: 'y' });
  eq(p.split('\n')[0], '[Scheduled script, daemon authored, not the owner.]');
});

t('a huge output is clipped with a pointer', () => {
  const p = scheduledScriptPrompt({ item: { id: 1, script: '/a/s.mjs', text: 't' }, output: 'x'.repeat(SCRIPT_OUTPUT_MAX + 50) });
  ok(p.includes(`cut at ${SCRIPT_OUTPUT_MAX} characters`) && p.length < SCRIPT_OUTPUT_MAX + 400, String(p.length));
});

// ── the wiring in bridge.mjs (text only) ────────────────────────────────
const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
const fn = (name) => {
  const i = src.indexOf(`function ${name}(`);
  ok(i !== -1, `no function ${name}`);
  const next = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, next === -1 ? undefined : next);
};

t('checkSchedules: the hours branch sits before the one-off branch, the script branch before every other action', () => {
  const body = fn('checkSchedules');
  const hours = body.indexOf("} else if (s.kind === 'hours') {");
  const once = body.indexOf('} else if (Date.now() >= s.at) {');
  ok(hours !== -1 && hours < once, 'an hours item would be read as a one-off');
  ok(body.includes('s.lastFiredAt = latestHoursSlot(s, Date.now());'), 'stamped with the slot');
  const script = body.indexOf('if (s.script) {');
  ok(script !== -1 && script < body.indexOf('if (s.switchAccount) {') && script < body.indexOf('if (s.run) {'), 'script first');
});

t('runScheduledScript dispatches only a non-empty prompt to the chat lane', () => {
  const body = fn('runScheduledScript');
  ok(body.includes('scheduledScriptPrompt({ item: s, output: stdout, ownerName: OWNER_NAME })'), 'prompt builder');
  ok(body.includes('if (!prompt) {') && body.indexOf('if (!prompt) {') < body.indexOf('dispatchPrompt(prompt, LANES.main, { priority: true });'), 'empty is a log line');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
