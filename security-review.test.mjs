#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.ADMISSION_DIR || HERE;
const G = await import(pathToFileURL(path.join(DIR, 'write-grant.mjs')));
const TMP = fs.mkdtempSync(path.join(tmpdir(), 'security-review-'));
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } };
const src = fs.readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}
const file = path.join(TMP, 'write-grants.json');
const store = G.createWriteGrantStore({ file });
const item = { text: 'authorized child', scheduleId: 233, queuedAt: 'now', allowWrite: true };
function proof(token, target = item) { return G.signWriteGrant ? G.signWriteGrant(token, target) : token; }
t('forged ledger record cannot authorize a child', () => {
  const token = 'attacker-token';
  fs.writeFileSync(file, JSON.stringify({ grants: { [G.grantHash(token)]: { scheduleId: '233', runId: 'bad', at: Date.now() } } }));
  assert.equal(store.verify(token, 233, item), false);
});
t('reused capability is refused after its first child', () => {
  const token = store.issue(233, 'parent'); const p = proof(token);
  assert.equal(store.verify(p, 233, item), true);
  assert.equal(store.verify(p, 233, item), false);
});
t('a capability bound to one run refuses another run', () => {
  const token = store.issue(233, 'parent'); const p = proof(token);
  assert.equal(store.verify(typeof p === 'object' ? { ...p, runId: 'another-run' } : p, 233, item, 'another-run'), false);
});
t('a child proof cannot authorize changed text or another schedule', () => {
  const token = store.issue(233, 'parent'); const p = proof(token);
  assert.equal(store.verify(p, 233, { ...item, text: 'different task' }), false);
  assert.equal(store.verify(p, 234, item), false);
});
t('queue proof contains no private capability', () => {
  const token = store.issue(233, 'parent');
  const p = proof(token);
  assert.equal(JSON.stringify(p).includes(token), false);
  assert.equal(JSON.stringify(p).includes('PRIVATE KEY'), false);
});
t('a forged death record cannot mint retry authority', () => {
  const retry = { ...item };
  if (store.seal) store.seal(retry, 'never-spawned', { resume: true });
  else retry.writeGrant = store.issue(233, 'never-spawned');
  assert.equal(retry.writeGrant, undefined);
});
let schedules = { items: [] }, queued = [];
const scope = {
  writeGrants: store, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync,
  BG_QUEUE_FILE: path.join(TMP, 'bg-queue.json'), loadSchedules: () => schedules,
  saveSchedules: s => { schedules = s; }, localToday: () => '2026-10-13', localHHMM: () => '12:00',
  isDailyDue: () => true, engineFor: () => ({ engine: 'claude' }), runningBgWorkers: () => 6,
  admissionNow: () => ({ now: Date.now() }), admissionVerdict: () => ({ admit: false }),
  MAX_CONCURRENT_WORKERS: 6, bridgeJobsRunning: () => 6, loadGate: x => x,
  noteBgWaiting: () => {}, describeWhen: () => 'now',
};
const harness = new Function(...Object.keys(scope), `${grab('scheduleApprovesWrites')}\n${grab('queueScheduledRun')}\n${grab('checkSchedules')}\nreturn { checkSchedules, scheduleApprovesWrites };`)(...Object.values(scope));
for (const kind of ['once', 'in']) t(`${kind} fire retains approval for its queued run, child and retry after restart`, () => {
  schedules = { items: [{ id: 233, kind, at: 0, run: true, allowWrite: true, text: 'job' }] };
  fs.writeFileSync(scope.BG_QUEUE_FILE, '[]'); harness.checkSchedules();
  assert.equal(schedules.items.length, 0);
  const q = JSON.parse(fs.readFileSync(scope.BG_QUEUE_FILE))[0];
  assert.equal(harness.scheduleApprovesWrites(233, q.executionId), true);
  const restarted = G.createWriteGrantStore({ file });
  assert.equal(restarted.verify(q.writeGrant, 233, q), true);
  for (const runId of ['child', 'retry']) {
    const child = { ...item, executionId: q.executionId };
    const cap = restarted.issue(233, runId, q.executionId);
    assert.equal(restarted.approves(233, q.executionId, []), true);
    assert.equal(restarted.verify(proof(cap, child), 233, child), true);
  }
});
t('explicit retained revocation wins over a consumed receipt', () => {
  const execution = store.fire?.({ id: 233, kind: 'once', run: true, allowWrite: true });
  schedules = { items: [{ id: 233, run: true, allowWrite: false }] };
  assert.equal(harness.scheduleApprovesWrites(233, execution), false);
});
t('pre-fire deletion grants no execution approval', () => {
  schedules = { items: [] }; harness.checkSchedules();
  assert.equal(harness.scheduleApprovesWrites(233, 'not-fired'), false);
});
t('deleted recurring schedule and unreadable schedule store fail closed', () => {
  const execution = store.fire?.({ id: 233, kind: 'daily', run: true, allowWrite: true });
  schedules = { items: [] };
  assert.equal(harness.scheduleApprovesWrites(233, execution), false);
  schedules = { items: [], unreadable: true };
  assert.equal(harness.scheduleApprovesWrites(233, execution), false);
});
t('an unreadable signing key fails closed and never throws at load', () => {
  fs.mkdirSync(path.join(TMP, 'dir-key.key'));
  assert.equal(G.createWriteGrantStore({ file: path.join(TMP, 'dir-key.json') }).issue(233, 'parent'), null);
});
t('a short signing key fails closed', () => {
  fs.writeFileSync(path.join(TMP, 'short-key.key'), 'abc');
  assert.equal(G.createWriteGrantStore({ file: path.join(TMP, 'short-key.json') }).issue(233, 'parent'), null);
});
t('a store that is built but never used creates no key (importing bridge.mjs stays inert)', () => {
  const s = G.createWriteGrantStore({ file: path.join(TMP, 'inert.json') });
  s.snapshot();
  assert.equal(fs.existsSync(path.join(TMP, 'inert.key')), false);
  assert.ok(s.issue(233, 'parent'), 'first use still creates the key and mints');
  assert.equal(fs.statSync(path.join(TMP, 'inert.key')).mode & 0o777, 0o600);
});
t('the ledger drops expired grants and executions', () => {
  let clock = 1_000_000;
  const s = G.createWriteGrantStore({ file: path.join(TMP, 'bounded.json'), now: () => clock });
  s.issue(233, 'a'); s.issue(233, 'b'); s.fire({ id: 9, kind: 'once', run: true, allowWrite: true });
  clock += G.GRANT_KEEP_MS + 1;
  s.issue(233, 'c');
  assert.equal(Object.keys(s.snapshot().grants).length, 1);
  assert.equal(Object.keys(s.snapshot().executions).length, 0);
});
t('a fired once approval lapses with the grant window', () => {
  let clock = 5_000_000;
  const s = G.createWriteGrantStore({ file: path.join(TMP, 'lapse.json'), now: () => clock });
  const id = s.fire({ id: 77, kind: 'once', run: true, allowWrite: true });
  assert.equal(s.approves(77, id, []), true);
  clock += G.GRANT_KEEP_MS + 1;
  assert.equal(s.approves(77, id, []), false);
});
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
