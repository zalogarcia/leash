import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexWorkerContext } from './codex-worker-env.mjs';

const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (error) { failures.push(`${name}: ${error.message}`); }
}
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end);
}
const inherited = { PATH: '/bin', LEASH_LANE: 'bg', LEASH_TRIGGER: 'schedule', LEASH_ALLOW_WRITE: '1', BG_REPORT_DRAFT: '/wrong' };
test('chat app-server scrubs background approval and draft keys', () => {
  const { env, draftPath } = codexWorkerContext(inherited);
  assert.equal(env.LEASH_LANE, 'chat');
  for (const key of ['LEASH_TRIGGER', 'LEASH_ALLOW_WRITE', 'BG_REPORT_DRAFT']) assert.equal(env[key], undefined);
  assert.equal(draftPath, null);
  assert.equal(inherited.LEASH_ALLOW_WRITE, '1');
});
test('background draft is writable within job cwd and reporting instructions name it', () => {
  const context = codexWorkerContext(inherited, { background: true, cwd: '/repo', runId: 'codex-42', startedAt: 42 });
  assert.equal(context.draftPath, '/repo/.bridge-codex-42.draft.md');
  assert.equal(context.env.BG_REPORT_DRAFT, context.draftPath);
  assert.equal(context.env.BG_RUN_STARTED_AT, '42');
  assert.equal(context.env.LEASH_ALLOW_WRITE, undefined);
  assert.ok(context.instructions.includes(context.draftPath));
});
test('scheduled worker grants writes only from literal approved consent', () => {
  for (const allowWrite of [false, 'true', 1, true]) {
    const { env } = codexWorkerContext({}, { background: true, mode: 'ask', schedule: { id: 9, allowWrite } });
    assert.equal(env.LEASH_TRIGGER, 'schedule');
    assert.equal(env.LEASH_SCHEDULE_ID, '9');
    assert.equal(env.LEASH_ALLOW_WRITE, allowWrite === true ? '1' : undefined);
    assert.equal(env.BG_REPORT_DRAFT, undefined);
  }
});
function dispatch(transport, enabled, options = {}) {
  let captured;
  // This build reads the opt-in through confBool (the environment layer can
  // only hand back a string), so that is the seam the setting arrives through.
  const fn = new Function('bgCodexTransport', 'codexAppServerState', 'confBool', 'runCodexAppServerJob', 'runCodex', `${extract('startCodexJob')}\nreturn startCodexJob;`)(
    () => transport, () => ({ fallback: false }), () => enabled,
    (text, args) => { captured = args; }, (text, args) => { captured = args; },
  );
  fn('task', options);
  return captured;
}
for (const transport of ['appserver', 'exec']) {
  test(`${transport}: network is off by default`, () => assert.equal(dispatch(transport, false).network, false));
  test(`${transport}: owner background network opt-in reaches transport`, () => assert.equal(dispatch(transport, true).network, true));
  test(`${transport}: handoff stays offline with opt-in and explicit network`, () => assert.equal(dispatch(transport, true, { carriesHandoff: true, network: true }).network, false));
  test(`${transport}: explicit network false beats enabled setting`, () => assert.equal(dispatch(transport, true, { network: false }).network, false));
  test(`${transport}: schedule is passed unchanged`, () => {
    const schedule = { id: 4, allowWrite: false };
    assert.equal(dispatch(transport, false, { schedule }).schedule, schedule);
  });
}
test('both spawn paths use worker context environment', () => {
  assert.match(extract('runCodex'), /spawnWorker\(CODEX_BIN, args, \{ cwd: runCwd, env: worker\.env/);
  assert.match(extract('runCodexAppServerJob'), /startAppServerChild\(\{ onDeath: onServerDeath, env: worker\.env \}\)/);
  assert.match(extract('startAppServerChild'), /env: env \|\| codexWorkerContext\(process\.env\)\.env/);
});
test('resume rechecks schedule approval and saves id instead of old consent', () => {
  assert.match(extract('recoverCodexAppServerJob'), /allowWrite: rec\.allowWrite === true && scheduleApprovesWrites\(rec\.scheduleId, rec\.executionId\)/);
  assert.match(extract('runCodexAppServerJob'), /scheduleId: schedule\?\.id \?\? null/);
});
test('scheduled phone and dropbox dispatches forward schedule marks', () => {
  assert.match(extract('startResolvedRun'), /schedule: item\.schedule \|\| null/);
  const drain = extract('drainBgHandoff');
  assert.match(drain, /codexSchedule = typeof it === 'object'[\s\S]*allowWrite: it\.allowWrite === true && scheduleApprovesWrites\(it\.scheduleId, it\.executionId\)/);
  assert.match(drain, /startCodexJob\(text, \{[\s\S]*?schedule: codexSchedule,/);
});
for (const failure of failures) process.stderr.write(`${failure}\n`);
process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
process.exitCode = failures.length ? 1 : 0;
