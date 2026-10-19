import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexFailoverPlan } from './codex-failover.mjs';
import { stripLaneRules } from './bg-notify.mjs';
const failure = { status: 'failed', failure: 'rate_limit' };
const healthy = { claudeAvailable: true, now: 100, claudePausedUntil: 0 };
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'edit' }), null);
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'edit', preActivity: true }).engine, 'claude');
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'ask' }).readOnly, true);
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'review' }).engine, 'claude');
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'ask', claudePausedUntil: 101 }), null);
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'ask', claudeAvailable: false }), null);
assert.equal(codexFailoverPlan(failure, { ...healthy, mode: 'ask', retried: true }), null);
assert.equal(codexFailoverPlan({ status: 'finished' }, { ...healthy, mode: 'ask' }), null);
assert.equal(codexFailoverPlan({ status: 'stopped' }, { ...healthy, mode: 'ask', bootstrap: true }), null);
assert.equal(codexFailoverPlan({ status: 'failed', failure: 'other' }, { ...healthy, mode: 'edit', preActivity: true }), null);
assert.equal(codexFailoverPlan({ status: 'failed', failure: 'other' }, { ...healthy, mode: 'edit', preActivity: true, bootstrap: true }).engine, 'claude');
const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
const at = source.indexOf('function retryCodexOnClaude(');
const end = source.indexOf('\nfunction reportCodexOutcome(', at);
const calls = [];
const main = { name: 'main' }, bg = { name: 'bg' };
const SENT_LINES = [];
const fsMod = await import('node:fs');
const osMod = await import('node:os');
const pathMod = await import('node:path');
const QDIR = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'takeover-q-'));
const QFILE = pathMod.join(QDIR, 'bg-queue.json');
let drains = 0;
const retry = new Function('codexFailoverPlan', 'dispatchPrompt', 'stripLaneRules', 'SENT_LINES', 'readFileSync', 'writeFileSync', 'renameSync', 'BG_QUEUE_FILE', 'drainBgHandoff', `
const CLAUDE_AVAILABLE = true, rotationPausedUntil = 0;
const LANES = { main: ${JSON.stringify(main)} }, getBgLane = () => (${JSON.stringify(bg)});
const claudeRateWalled = () => false, chatState = () => ({ cwd: '/other' });
const send = (t) => { SENT_LINES.push(t); return Promise.resolve(); };
${source.slice(at, end)}
return retryCodexOnClaude;
`)(codexFailoverPlan, (...args) => calls.push(args), stripLaneRules, SENT_LINES, fsMod.readFileSync, fsMod.writeFileSync, fsMod.renameSync, QFILE, () => { drains++; });
// A BACKGROUND takeover is QUEUED, pinned to Claude, never put straight on a
// lane: the drain applies the admission cap (QA round 2: N failing Codex jobs
// had become N uncapped Claude workers). A real file write, read back.
fsMod.writeFileSync(QFILE, JSON.stringify([{ text: 'an earlier job' }]));
assert.equal(retry('Review work', failure, { mode: 'review', cwd: '/target', prompt: 'Acceptance criteria and quote', background: true, schedule: { id: 4, allowWrite: false } }), true);
assert.equal(calls.length, 0, 'a background takeover must not bypass the drain');
const queued = JSON.parse(fsMod.readFileSync(QFILE, 'utf8'));
assert.equal(queued.length, 2, 'the earlier queue item was lost');
assert.equal(queued[0].text, 'an earlier job');
assert.equal(queued[1].text, 'claude: Review work');
assert.equal(queued[1].engine, 'claude');
assert.equal(queued[1].cwd, '/target');
assert.equal(queued[1].scheduleId, 4);
assert.equal(queued[1].allowWrite, undefined, 'a schedule without write consent must not gain it');
assert.ok(queued[1].prepend.includes('Acceptance criteria and quote'));
assert.ok(queued[1].prepend.includes('read-only request'));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(drains, 1, 'the drain was not kicked');
fsMod.rmSync(QDIR, { recursive: true, force: true });
assert.equal(retry('Write work', failure, { mode: 'edit', preActivity: false }), false);
assert.equal(calls.length, 0);
// A CHAT takeover on an idle lane is HIS message: no priority (so a Claude
// limit death re-runs it after the swap); a worker report keeps its mark.
const mark = { items: [{ runId: 'bg-1' }] };
assert.equal(retry('their question', failure, { mode: 'ask' }), true);
assert.equal(calls[0][1].name, 'main');
assert.equal(calls[0][2].priority, false);
assert.equal(calls[0][2].handback, null);
assert.equal(retry('[Report] done', failure, { mode: 'ask', handback: mark }), true);
assert.equal(calls[1][2].priority, true);
assert.equal(calls[1][2].handback, mark);
calls.length = 0;
assert.ok(source.includes('const cwd = requestedCwd && (() => { try { return statSync(requestedCwd).isDirectory(); } catch { return false; } })() ? requestedCwd'));
// The task goes to Claude ONCE: when the prompt is just the task, the prepend
// carries the takeover note and nothing else.
calls.length = 0;
assert.equal(retry('Answer the question', failure, { mode: 'ask', prompt: 'Answer the question' }), true);
assert.equal(calls[0][0], 'claude: Answer the question');
assert.equal(calls[0][2].prepend.split('Answer the question').length, 1);
// A Claude takeover is handed the brief as given, never the Codex-wrapped
// prompt: the reply rules and the in-repo draft path are instructions for
// Codex only.
const reportCalls = source.match(/reportCodexOutcome\(rawText, outcome, runId, \{[^\n]*\}\)/g) || [];
assert.equal(reportCalls.length, 3);
for (const call of reportCalls) assert.ok(call.includes('prompt: brief'), call);
assert.equal((source.match(/const brief = stripLaneRules\(String\(sendText \?\? rawText \?\? ''\)\)\.trim\(\);/g) || []).length, 2);
// Compaction is a Claude-session operation: pinned, so a Claude wall holds it
// rather than handing it to the Codex chat lane.
assert.ok(source.includes('dispatchPrompt(`claude: ${COMPACT_PROMPT}`, LANES.main, { priority: true });'));
assert.ok(!source.includes('dispatchPrompt(COMPACT_PROMPT,'));
// An app-server that will not start is not "Codex unavailable": exec is still
// Codex, so the chat lane falls back to it first, and Claude stands in only
// when the one-shot cannot launch either (its outcome carries bootstrap).
const unusable = source.slice(source.indexOf("console.error('[bridge] codex app-server unavailable:'"), source.indexOf("runCodexChatExec(rawText, { images, prompt, carriesHandoff, fellBack: codexAppServerState().reason || 'init_failed', alreadyRinged: true, handback });"));
assert.ok(unusable.length > 0 && !unusable.includes('retryCodexOnClaude('), 'the app-server failure path must reach the exec fallback');
assert.ok(source.includes("answer: `Codex FAILED to launch: ${detail}`, record: `FAILED: ${detail}`, tokens: null, bootstrap: true };"));
// A CLAUDE WORKER'S CWD IS A DECLARED DIRECTORY OR NOTHING. The brief
// inference picks the first `~/dev/<x>` it sees, and `~/dev/CLAUDE.md` is a
// file: as a cwd it made spawn throw ENOTDIR after runClaude had claimed the
// lane (QA round 1). Evaluated for real against a file, a dir and a missing path.
{
  const { statSync, mkdtempSync, writeFileSync: wf, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const dir = mkdtempSync(p.join(os.tmpdir(), 'cwd-pick-'));
  const file = p.join(dir, 'CLAUDE.md');
  wf(file, 'x');
  try {
    const at2 = source.indexOf("\n    const declaredCwd = typeof it === 'object' && it?.cwd ? it.cwd : null;") + 1;
    const end2 = source.indexOf('    // A CLAUDE PIN IS FORWARDED', at2);
    assert.ok(at2 > 1 && end2 > at2);
    const block = source.slice(at2, end2);
    assert.ok(!block.includes('codexCwdForBrief('), 'a Claude worker must not run in an inferred directory');
    const pick = new Function('statSync', 'it', `${block}\nreturn cwd;`);
    assert.equal(pick(statSync, { cwd: dir }), dir);
    assert.equal(pick(statSync, { cwd: file }), null);
    assert.equal(pick(statSync, { cwd: p.join(dir, 'gone') }), null);
    assert.equal(pick(statSync, 'a plain string item'), null);
    const line = source.split('\n').find((l) => l.startsWith('    const cwd = requestedCwd && '));
    const run = new Function('statSync', 'existsSync', 'requestedCwd', 'st', 'HOME', `${line}\nreturn cwd;`);
    assert.equal(run(statSync, () => true, file, { cwd: '/chat' }, '/home'), '/chat');
    assert.equal(run(statSync, () => true, dir, { cwd: '/chat' }, '/home'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// A takeover says WHY Codex did not answer, in the same message as who is
// answering instead (QA round 1: a bad /codex model was silently replaced by
// Claude on every message, with the Codex error never shown).
SENT_LINES.length = 0;
assert.equal(retry('hi', { status: 'failed', failure: 'other' }, { mode: 'chat', preActivity: true, bootstrap: true, notice: '❌ Codex: unknown model gpt-x' }), true);
assert.equal(SENT_LINES.length, 1);
assert.equal(SENT_LINES[0], '❌ Codex: unknown model gpt-x\n🔄 Claude is taking over this task.');
assert.equal((source.match(/notice: outcome\.status === 'failed' \? codexChatError\(outcome/g) || []).length, 2, 'both chat transports pass the Codex error');
// A runtime takeover of a /codex QUESTION (mode ask) answers in the chat, not
// as a background worker handback.
assert.ok(source.includes("background: mode !== 'ask', prompt:"));
// The drain forwards a Claude pin and the takeover note to the lane.
assert.ok(source.includes('dispatchPrompt(pinnedClaude ? `claude: ${text}` : text, lane, { priority: true, schedule, cwd, prepend: itemPrepend });'));
// A held worker report is kept (keepHandback), never parked in memory.
assert.equal((source.match(/keepHandback\(item\.handback, 'wall'\)/g) || []).length, 2);
process.stdout.write('60 passed, 0 failed\n');
