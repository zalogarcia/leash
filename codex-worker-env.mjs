import path from 'node:path';
import { workerEnv } from './worker-env.mjs';

// Drafts stay inside the job's writable directory. The shared reports directory
// belongs to the daemon and is outside a background Codex sandbox.
export const codexDraftPath = (cwd, runId) => path.join(cwd, `.bridge-${runId}.draft.md`);

export function codexWorkerContext(base, { background = false, cwd, runId, startedAt, schedule = null, mode = 'edit' } = {}) {
  const draftPath = background && mode === 'edit' ? codexDraftPath(cwd, runId) : null;
  return {
    draftPath,
    env: workerEnv(base, { lane: background ? 'bg' : 'chat', draftPath, startedAt: background ? startedAt : null, schedule: background ? schedule : null }),
    instructions: draftPath
      ? `Background report: keep your findings, changed files, checks and unfinished work in ${draftPath}. Write it before asking another agent to verify your work, and update it before your final reply. The draft is a recovery file; still give the full result in your final reply. Stay in this turn until your task is finished.`
      : '',
  };
}
