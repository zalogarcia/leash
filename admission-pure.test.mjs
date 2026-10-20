#!/usr/bin/env node
// The pure and file-store halves of the admission gates and the write grant
// (self audit 2026-10-13, P2 and P8). The wiring is proven through the real
// drain by admission-gates.test.mjs and schedule-approval-retry.test.mjs.
//
//   node admission-pure.test.mjs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ADMISSION_DEFAULTS,
  admissionSettings,
  admissionVerdict,
  admissionRows,
  admissionLine,
  loadGate,
  queuedBlock,
  reasonLines,
} from './bg-admission.mjs';
import { waitingLine } from './bg-notify.mjs';
import { createBgWaitStore, waitKey } from './bg-wait.mjs';
import { createWriteGrantStore, signWriteGrant, grantHash, GRANT_KEEP_MS } from './write-grant.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'admission-pure-'));
let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('\n1. settings');
await t('absent means ON with 2 per core and 90 percent', () => {
  eq(JSON.stringify(admissionSettings(undefined)), JSON.stringify({ loadPerCore: 2, usagePercent: 90 }));
  eq(ADMISSION_DEFAULTS.loadPerCore, 2);
});
await t('false switches both new gates off; 0 switches one', () => {
  eq(JSON.stringify(admissionSettings(false)), JSON.stringify({ loadPerCore: 0, usagePercent: 0 }));
  eq(JSON.stringify(admissionSettings('off')), JSON.stringify({ loadPerCore: 0, usagePercent: 0 }));
  eq(admissionSettings({ loadPerCore: 0 }).loadPerCore, 0);
  eq(admissionSettings({ loadPerCore: 0 }).usagePercent, 90);
});
await t('a typo is the default, a tiny value is floored, never a silent off', () => {
  eq(admissionSettings({ loadPerCore: 'two', usagePercent: 'x' }).loadPerCore, 2);
  eq(admissionSettings({ loadPerCore: 0.1 }).loadPerCore, 0.5);
  eq(admissionSettings({ usagePercent: 9 }).usagePercent, 50);
  eq(admissionSettings({ usagePercent: 120 }).usagePercent, 100);
});

console.log('\n2. the load gate');
await t('over the limit with a bridge job running is high; with none it is not', () => {
  const g = loadGate({ load1: 30, ncpu: 14, loadPerCore: 2, bridgeRunning: 1 });
  eq(g.limit, 28);
  eq(g.high, true);
  eq(loadGate({ load1: 30, ncpu: 14, loadPerCore: 2, bridgeRunning: 0 }).high, false);
  eq(loadGate({ load1: 28, ncpu: 14, loadPerCore: 2, bridgeRunning: 3 }).high, false, 'at the limit is not over it');
  eq(loadGate({ load1: 99, ncpu: 14, loadPerCore: 0, bridgeRunning: 3 }).high, false, 'off');
  eq(loadGate({ load1: NaN, ncpu: 14, bridgeRunning: 3 }).high, false, 'no reading');
});

console.log('\n3. the verdict and its order');
const LOADED = { high: true, load1: 41.2, ncpu: 14, limit: 28 };
const HOLD = { account: 'b@', percent: 93, label: 'the 5 hour window', resetsAtMs: Date.UTC(2026, 9, 13, 19, 0) };
await t('the count first: 6 of 6 is "cap" even when the load is high too', () => {
  const v = admissionVerdict({ running: 6, max: 6, load: LOADED, usage: HOLD });
  eq(v.kind, 'cap');
  eq(v.text, 'waiting: 6 of 6 Claude workers busy');
});
await t('then a resume over its pace, then the load, then the usage window', () => {
  eq(admissionVerdict({ running: 2, max: 6, itemMax: 2, pacedRunning: 2, load: LOADED }).kind, 'pace');
  eq(admissionVerdict({ running: 2, max: 6, load: LOADED, usage: HOLD }).kind, 'load');
  const u = admissionVerdict({ running: 2, max: 6, usage: HOLD });
  eq(u.kind, 'usage');
  eq(u.text, 'waiting: b@ is at 93% of the 5 hour window, no other account free · resets 19:00');
  eq(admissionVerdict({ running: 2, max: 6 }).admit, true);
});
await t('a retry before its time waits first, even with --now', () => {
  const v = admissionVerdict({ notBefore: 2000, now: 1000, bypass: true });
  eq(v.kind, 'retry');
  eq(admissionVerdict({ notBefore: 2000, now: 2001, running: 0, max: 6 }).admit, true);
});
await t('--now passes the count, the load and the usage', () => {
  eq(admissionVerdict({ bypass: true, running: 9, max: 6, load: LOADED, usage: HOLD }).admit, true);
});
await t('Codex answers the load only', () => {
  eq(admissionVerdict({ engine: 'codex', running: 9, max: 6, usage: HOLD }).admit, true);
  eq(admissionVerdict({ engine: 'codex', running: 0, max: 6, load: LOADED }).kind, 'load');
});

console.log('\n4. ps');
await t('rows carry their reason; a row admitted ahead fills the pool for the next', () => {
  const rows = admissionRows(
    [{ title: 'a', engine: 'claude' }, { title: 'b', engine: 'claude' }, { title: 'c', engine: 'codex' }],
    { running: 5, max: 6 },
  );
  eq(rows.map((r) => r.waiting).join(','), 'false,true,false');
  eq(rows[1].reason, 'waiting: 6 of 6 Claude workers busy');
  eq(rows[0].reason, null);
});
await t('the load floor counts the jobs admitted ahead in the same view', () => {
  const rows = admissionRows([{ title: 'a' }, { title: 'b' }], { running: 0, max: 6, load: { load1: 50, ncpu: 14, loadPerCore: 2 }, bridgeRunning: 0 });
  eq(rows.map((r) => r.waiting).join(','), 'false,true');
  eq(rows[1].kind, 'load');
});
await t('the QUEUED block lists each reason once, with the jobs it holds', () => {
  const rows = admissionRows([{ title: 'a' }, { title: 'b' }], { running: 6, max: 6 });
  const block = queuedBlock(rows, { running: 6, max: 6 });
  ok(block.includes('waiting: 6 of 6 Claude workers busy · #1 #2'), block);
  eq(reasonLines(rows).length, 1);
  ok(!/[\u2013\u2014]/.test(block), 'no dashes');
});
await t('the ADMISSION line says the count, the load and the usage gate', () => {
  eq(
    admissionLine({ running: 3, max: 6, load: { high: false, load1: 12.4, ncpu: 14, limit: 28 } }),
    'ADMISSION · Claude workers: 3 of 6 busy · load 12 of 28 (14 cores) · usage gate clear',
  );
  const held = admissionLine({ running: 6, max: 6, load: LOADED, usage: HOLD });
  ok(held.includes('load 41 of 28 (14 cores), new jobs wait'), held);
  ok(held.includes('usage: b@ at 93% of the 5 hour window, new Claude jobs wait, resets 19:00'), held);
  ok(!/[\u2013\u2014]/.test(held), 'no dashes');
});

console.log('\n5. the waiting line (house style)');
await t('icon, label, value; one fact per line; the ⏳ line; no dashes', () => {
  const l = waitingLine({ brief: 'LANE RULES\n\n--- TASK ---\n\n# Fix the importer', reason: 'waiting: 6 of 6 Claude workers busy' });
  const lines = l.split('\n');
  eq(lines[0], '📥 Queued');
  eq(lines[1], 'Fix the importer');
  eq(lines[2], '⏳ waiting: 6 of 6 Claude workers busy');
  eq(lines[3], 'starts by itself when that clears · bg.mjs ps');
  ok(!/[\u2013\u2014]/.test(l), 'no dashes');
});
await t('a scheduled job keeps the schedule head; a Codex job says codex', () => {
  eq(waitingLine({ brief: 'x', reason: 'waiting: y', scheduleId: 8, scheduleWhen: 'daily 03:00' }).split('\n')[0], '⏰ #8 · daily 03:00 · 📥 queued');
  eq(waitingLine({ brief: 'x', reason: 'waiting: y', engine: 'codex' }).split('\n')[0], '📥 Queued · codex');
});

console.log('\n6. the waiting line store (bg-wait.mjs)');
await t('the key is the queue stamp plus the text, stable across requeues', () => {
  const a = { text: 'brief', queuedAt: '2026-10-13T10:00:00Z' };
  eq(waitKey(a), waitKey({ ...a, now: false }));
  ok(waitKey(a) !== waitKey({ ...a, queuedAt: 'other' }));
  eq(waitKey({}), null);
});
await t('a send in flight is handed over exactly once; a landed one survives a restart', async () => {
  const file = path.join(TMP, 'w.json');
  const s1 = createBgWaitStore({ file });
  const key = waitKey({ text: 'b', queuedAt: '1' });
  s1.track(key, Promise.resolve(42), { kind: 'cap', text: 'waiting: 6 of 6' });
  ok(s1.pending(key), 'pending while the send is in flight');
  await new Promise((r) => setTimeout(r, 5));
  eq(s1.get(key).msgId, 42);
  const s2 = createBgWaitStore({ file }); // a restart
  eq(s2.get(key).msgId, 42);
  eq(s2.take(key), 42);
  eq(s2.take(key), null, 'exactly once');
  eq(createBgWaitStore({ file }).get(key), null, 'and gone from disk');
});
await t('a job taken while its send is in flight gets the promise, and nothing is left behind', async () => {
  const file = path.join(TMP, 'w2.json');
  const s = createBgWaitStore({ file });
  const key = waitKey({ text: 'c', queuedAt: '2' });
  let resolve;
  s.track(key, new Promise((r) => (resolve = r)), { kind: 'cap' });
  const p = s.take(key);
  resolve(7);
  eq(await p, 7);
  await new Promise((r) => setTimeout(r, 5));
  eq(s.get(key), null, 'not recorded after it was taken');
});

console.log('\n7. the write grant store (write-grant.mjs)');
await t('a grant verifies only once for its signed child and contains no private key on disk', () => {
  const file = path.join(TMP, 'g.json');
  const g = createWriteGrantStore({ file });
  const token = g.issue(233, 'bg-1');
  const item = { scheduleId: 233, text: 'child' };
  const proof = signWriteGrant(token, item);
  eq(g.verify(proof, 235, item), false);
  eq(g.verify(proof, 233, item), true);
  eq(g.verify(proof, 233, item), false);
  ok(!readFileSync(file, 'utf8').includes('PRIVATE KEY'), 'private key never stored in ledger');
});
await t('an old grant expires; an unreadable store approves nothing', () => {
  const file = path.join(TMP, 'g2.json');
  let now = 1_000_000;
  const g = createWriteGrantStore({ file, now: () => now });
  const token = g.issue(9);
  now += GRANT_KEEP_MS + 1;
  eq(g.verify(token, 9), false);
  writeFileSync(file, '{not json');
  eq(createWriteGrantStore({ file }).verify(token, 9), false);
});
await t('a grant that cannot be saved is not handed out', () => {
  const g = createWriteGrantStore({ file: path.join(TMP, 'no-such-dir', 'g.json') });
  eq(g.issue(1), null);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
