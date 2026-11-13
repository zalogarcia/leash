#!/usr/bin/env node
// A job's own Claude model (`bg.mjs --model`).
//
// Two halves here. The ENQUEUE: bg.mjs, a real process on a copy in a temp dir,
// so the live drop box is never opened. The SPAWN: the real start of runClaude,
// the real dispatchPrompt, queueItem and drainQueue, cut out of bridge.mjs by
// fixtures/model-owner-rig.mjs, with the real startModel and BG_MODEL behind
// them. The DRAIN, the wall and the schedules are in bg-concurrency-wiring,
// wall-guard-wiring and schedule-model, beside their own harnesses.
//
//   node bg-job-model.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRig, test, summary, settle, grab, runPrefix, apiBody, source } from './fixtures/model-owner-rig.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-job-model-'));
copyFileSync(path.join(DIR, 'bg.mjs'), path.join(TMP, 'bg.mjs'));
const QUEUE = path.join(TMP, 'bg-queue.json');
const HOME = path.join(TMP, 'home');
mkdirSync(HOME);

function bg(args, extraEnv = {}) {
  const env = { ...process.env, HOME, ...extraEnv };
  for (const k of ['LEASH_TRIGGER', 'LEASH_SCHEDULE_ID', 'LEASH_ALLOW_WRITE', 'LEASH_WRITE_GRANT', 'TMUX', 'LINEAR_API_KEY', 'BRIDGE_CONFIG']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [path.join(TMP, 'bg.mjs'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const fresh = () => rmSync(QUEUE, { force: true });
const queued = () => JSON.parse(readFileSync(QUEUE, 'utf8'));
const sum = () => (existsSync(QUEUE) ? createHash('sha256').update(readFileSync(QUEUE)).digest('hex') : 'no file');
const BRIEF = '# Fix the importer for good\n\nDo the thing.';

// ---------------------------------------------------------------------------
// The enqueue
// ---------------------------------------------------------------------------
await test('--model sonnet: the queue entry carries model sonnet and is pinned to Claude', () => {
  fresh();
  const r = bg(['--model', 'sonnet', BRIEF]);
  assert.equal(r.code, 0, r.err);
  const [item] = queued();
  assert.equal(item.model, 'sonnet');
  assert.equal(item.engine, 'claude');
});
await test('each alias is accepted, in any case', () => {
  for (const [typed, stored] of [['sonnet', 'sonnet'], ['opus', 'opus'], ['haiku', 'haiku'], ['SONNET', 'sonnet']]) {
    fresh();
    assert.equal(bg(['--model', typed, BRIEF]).code, 0);
    assert.equal(queued()[0].model, stored);
  }
});
await test('with no flag the entry has no model and no pin, exactly as before', () => {
  fresh();
  assert.equal(bg([BRIEF]).code, 0);
  const [item] = queued();
  assert.equal('model' in item, false);
  assert.equal('engine' in item, false);
});
await test('the flag and its value never reach the brief', () => {
  fresh();
  bg(['--model', 'sonnet', '--no-track', BRIEF]);
  const { text } = queued()[0];
  assert.equal(text.includes('--model'), false);
  assert.equal(text.includes('--no-track'), false);
  assert.ok(text.includes('Do the thing.'));
});
await test('--model is a flag bg.mjs knows, so it is never read as an unknown first argument', () => {
  fresh();
  const r = bg(['--model', 'haiku', '--file', path.join(TMP, 'none.md')]);
  assert.doesNotMatch(r.err, /is not a flag this command takes/);
});
for (const [name, args] of [
  ['an unknown alias', ['--model', 'nonsense', BRIEF]],
  ['a missing value', ['--model']],
  ['the next flag eaten as the value', ['--model', '--now', BRIEF]],
  ['fable, whose fallback is the lane decision', ['--model', 'fable', BRIEF]],
  ['a full model id', ['--model', 'claude-sonnet-5-5', BRIEF]],
  ['a Codex job', ['--engine', 'codex', '--model', 'sonnet', BRIEF]],
  ['a codex: prefix', ['--model', 'sonnet', `codex: ${BRIEF}`]],
]) {
  await test(`${name}: one stderr line, nonzero, the drop box unchanged`, () => {
    fresh();
    bg(['# A job already waiting there\n\nbody']);
    const before = sum();
    const r = bg(args);
    assert.notEqual(r.code, 0, 'it must refuse');
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
    assert.match(r.err, /Nothing was queued/);
    assert.equal(sum(), before, 'the checksum moved');
  });
}
await test('the refusal with no file at all leaves no file', () => {
  fresh();
  assert.notEqual(bg(['--model', 'nonsense', BRIEF]).code, 0);
  assert.equal(existsSync(QUEUE), false);
});
await test('the enqueue list and the drain allow list are the same aliases', () => {
  const list = /const JOB_MODELS = \[([^\]]+)\]/.exec(readFileSync(path.join(DIR, 'bg.mjs'), 'utf8'))[1].match(/[a-z]+/g).sort().join('|');
  const drain = /\/\^\(\?:([a-z|]+)\)\$\/\.test\(String\(it\?\.model/.exec(source)[1].split('|').sort().join('|');
  assert.equal(drain, list);
});
await test('a scheduled run that names a model: the model, the Claude pin and the schedule mark ride together', () => {
  fresh();
  const brief = path.join(TMP, 'brief.md');
  writeFileSync(brief, '# A periodic list\n\nThe list.');
  const r = bg(['--model', 'sonnet', '--no-track', '--file', brief], { LEASH_TRIGGER: 'schedule', LEASH_SCHEDULE_ID: '7' });
  assert.equal(r.code, 0, r.err);
  const [item] = queued();
  assert.equal(item.model, 'sonnet');
  assert.equal(item.engine, 'claude');
  assert.equal(item.scheduleId, '7');
  assert.equal(item.allowWrite, undefined);
  assert.doesNotMatch(item.text, /^Work item:/m);
});

// ---------------------------------------------------------------------------
// The spawn: which model goes into argv
// ---------------------------------------------------------------------------
const bgLaneOf = (launch) => Object.assign(launch.lane, { name: 'bg', isBg: true });

await test('the real start of runClaude: the job model for that job, BG_MODEL for a job with none', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() }, bgModel: 'opus', chatModel: 'fable' }, async (r) => {
  const launch = runPrefix((lane, carried) => r.api.startModel(lane, carried), r.liveAccount);
  const bgLane = bgLaneOf(launch);
  await launch.run('with a model', bgLane, { jobModel: 'sonnet' });
  assert.equal(launch.counts().model, 'sonnet', 'the job named sonnet');
  await launch.run('no model', bgLane, {});
  assert.equal(launch.counts().model, 'opus', 'a job with none runs on BG_MODEL');
  await settle();
}));
await test('the chat lane /model cannot move either kind of job', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() }, bgModel: 'opus', chatModel: 'haiku' }, async (r) => {
  const launch = runPrefix((lane, carried) => r.api.startModel(lane, carried), r.liveAccount);
  const bgLane = bgLaneOf(launch);
  await launch.run('with a model', bgLane, { jobModel: 'sonnet' });
  assert.equal(launch.counts().model, 'sonnet');
  await launch.run('no model', bgLane, {});
  assert.equal(launch.counts().model, 'opus');
  await settle();
}));
await test('a job model on the chat lane is ignored: /model owns that lane', () => withRig({ rows: [{ name: 'a' }], bodies: { a: apiBody() }, bgModel: 'opus', chatModel: 'haiku' }, async (r) => {
  const launch = runPrefix((lane, carried) => r.api.startModel(lane, carried), r.liveAccount);
  launch.lane.isBg = false;
  await launch.run('chat', launch.lane, { jobModel: 'sonnet' });
  assert.equal(launch.counts().model, 'haiku');
  await settle();
}));
await test('a job model writes nothing to the lane decision: a Fable pool keeps its fallback record', () => withRig({ rows: [{ name: 'a', modelLimits: { fable: { until: 4102444800 } } }], bodies: { a: apiBody() }, bgModel: 'fable', chatModel: 'opus' }, async (r) => {
  const launch = runPrefix((lane, carried) => r.api.startModel(lane, carried), r.liveAccount);
  const bgLane = bgLaneOf(launch);
  await launch.run('pool job', bgLane, {});
  assert.equal(launch.counts().model, 'opus', 'Fable is out, so the pool falls back');
  const told = r.notices.length;
  await launch.run('with a model', bgLane, { jobModel: 'sonnet' });
  assert.equal(launch.counts().model, 'sonnet');
  await launch.run('pool job again', bgLane, {});
  assert.equal(launch.counts().model, 'opus');
  await settle();
  assert.equal(r.notices.length, told, 'a Sonnet job in between must not read as Fable restored and then lost');
}));
await test('the real dispatchPrompt and drainQueue carry it to the spawn, direct and through a busy lane', async () => {
  for (const busy of [false, true]) {
    const launch = runPrefix(() => 'opus');
    const lane = bgLaneOf(launch);
    const runs = [];
    lane.current = busy ? {} : null;
    const deps = { LANES: { main: {} }, parseEnginePrefix: (text) => ({ text }),
      engineForItem: () => ({ engine: 'claude' }), startResolvedRun: () => 'fallthrough',
      CLAUDE_AVAILABLE: true, takeHandoffPrefix: () => '', resolveQueueAck: () => {},
      asQueueItem: (item) => item, console,
      runClaude: (text, target, opts) => { const p = launch.run(text, target, opts); runs.push(p); return p; } };
    const api = new Function(...Object.keys(deps), `${['queueItem', 'dispatchPrompt', 'drainQueue'].map(grab).join('\n')}\nreturn {dispatchPrompt, drainQueue};`)(...Object.values(deps));
    api.dispatchPrompt('job', lane, { priority: true, jobModel: 'sonnet' });
    if (busy) { assert.equal(lane.queue.length, 1); lane.current = null; api.drainQueue(lane); }
    await Promise.all(runs);
    assert.equal(launch.counts().model, 'sonnet', busy ? 'through the queue' : 'direct');
  }
});
await test('the failure path of the one model owner does not touch a job model', () => {
  const start = grab('runClaude');
  assert.match(start, /selectedModel = jobModel && lane\.isBg \? jobModel : startModel\(lane, carriedModel\)/);
});

rmSync(TMP, { recursive: true, force: true });
summary();
