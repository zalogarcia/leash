import { unlinkSync } from 'node:fs';
import { readDraftReport, draftHandbackOutput, draftStatus } from './bg-draft.mjs';
import { codexDraftPath } from './codex-worker-env.mjs';

// A failed job's draft is recovery evidence, never proof that checks passed.
export function recoverCodexDraft(outcome, { cwd, runId, mode = 'ask', readDraft = readDraftReport } = {}) {
  if (mode !== 'edit' || !cwd || !runId || (outcome.status === 'finished' && outcome.record != null)) return outcome;
  const draft = readDraft(codexDraftPath(cwd, runId));
  if (!draft) return outcome;
  const answer = draftHandbackOutput(draft, outcome.answer);
  return { ...outcome, answer, record: answer, status: draftStatus(outcome.status) };
}

// The draft lives in the job's own working directory (the only place a
// background Codex sandbox may write), so it is an untracked file in the
// owner's repo. Once the outcome has been read it is removed: its text is in
// the outcome by then, and a leftover would sit in `git status` forever.
export function discardCodexDraft({ cwd, runId, mode = 'ask', unlink = unlinkSync } = {}) {
  if (mode !== 'edit' || !cwd || !runId) return false;
  try {
    unlink(codexDraftPath(cwd, runId));
    return true;
  } catch {
    return false; // never written, or already gone
  }
}
