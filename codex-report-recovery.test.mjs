import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverCodexDraft, discardCodexDraft } from './codex-report-recovery.mjs';
import { codexWorkerContext, codexDraftPath } from './codex-worker-env.mjs';
const failed = { status: 'failed', answer: 'rate limit', record: 'FAILED', tokens: { input_tokens: 10 } };
let count = 0;
const readDraft = (file) => { count += 1; assert.equal(file, '/repo/.bridge-codex-1.draft.md'); return { text: 'Changed 2 files. QA unfinished.', mtime: 'today' }; };
const recovered = recoverCodexDraft(failed, { cwd: '/repo', runId: 'codex-1', mode: 'edit', readDraft });
assert.ok(recovered.answer.includes('DRAFT REPORT'));
assert.ok(recovered.answer.includes('QA unfinished'));
assert.ok(recovered.answer.includes('rate limit'));
assert.ok(recovered.status.startsWith('failed') && recovered.status.includes('DRAFT report'));
assert.equal(recovered.tokens, failed.tokens);
const complete = { status: 'finished', answer: 'Final report', record: 'Final report' };
assert.equal(recoverCodexDraft(complete, { cwd: '/repo', runId: 'codex-1', mode: 'edit', readDraft }), complete);
assert.equal(recoverCodexDraft(failed, { cwd: '/repo', runId: 'codex-1', mode: 'ask', readDraft }), failed);
assert.equal(count, 1);
assert.equal(recoverCodexDraft(failed, { cwd: '/repo', runId: 'codex-1', mode: 'edit', readDraft: () => null }), failed);
const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
assert.ok(source.includes('outcome = recoverCodexDraft(outcome, { cwd, runId, mode });'));
// The draft sits in the owner's repo, so it is removed once read: a real file,
// a real unlink, in a scratch dir. The writer and the cleaner name ONE path.
const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-draft-'));
try {
  const ctx = codexWorkerContext({}, { background: true, cwd: dir, runId: 'codex-9', startedAt: 9, mode: 'edit' });
  assert.equal(ctx.draftPath, codexDraftPath(dir, 'codex-9'));
  writeFileSync(ctx.draftPath, 'draft');
  assert.equal(discardCodexDraft({ cwd: dir, runId: 'codex-9', mode: 'ask' }), false);
  assert.ok(existsSync(ctx.draftPath), 'a read-only run never wrote one and must not delete anything');
  assert.equal(discardCodexDraft({ cwd: dir, runId: 'codex-9', mode: 'edit' }), true);
  assert.ok(!existsSync(ctx.draftPath));
  assert.equal(discardCodexDraft({ cwd: dir, runId: 'codex-9', mode: 'edit' }), false, 'already gone is not an error');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
assert.equal((source.match(/discardCodexDraft\(\{ cwd, runId, mode \}\);/g) || []).length, 3);
process.stdout.write('18 passed, 0 failed\n');
