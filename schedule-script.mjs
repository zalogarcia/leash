// schedule-script.mjs: a schedule entry that runs a script.
//
// `schedule.mjs add every 2h 00:05 --script <path> "text"` stores an hours item
// with `script`. When it comes due, the daemon runs the script, and only when it
// prints something does that output reach the chat lane, as a turn the daemon
// authored with the entry's text on top. Empty output is one log line and no
// turn: a sweep script is empty most of the time, and a model turn every two
// hours to say "nothing" is the cost this shape exists to avoid.
//
// The framing follows the restart wake-up turn's (system-messages.mjs): a first
// line that says who wrote it and that it is not the owner, so the chat lane
// reads it as the daemon's data, never as an instruction from the owner.

import path from 'node:path';

export const SCRIPT_TIMEOUT_MS = 120_000;
export const SCRIPT_OUTPUT_MAX = 6000;

/** [command, args] for a script path: node for .mjs and .js, else the file itself. */
export function scriptCommand(script, nodeBin = process.execPath) {
  const file = String(script || '');
  return /\.(mjs|cjs|js)$/i.test(file) ? [nodeBin, [file]] : [file, []];
}

/** The chat turn for a script's output, or null when there is nothing to say. */
export function scheduledScriptPrompt({ item, output, ownerName = 'the owner' }) {
  const body = String(output ?? '').trim();
  if (!body) return null;
  const clipped = body.length > SCRIPT_OUTPUT_MAX ? `${body.slice(0, SCRIPT_OUTPUT_MAX)}\n[cut at ${SCRIPT_OUTPUT_MAX} characters; run ${item?.script} yourself for the rest]` : body;
  return [
    `[Scheduled script, daemon authored, not ${ownerName}.]`,
    `🗓️ Schedule #${item?.id ?? '?'} · ${path.basename(String(item?.script || 'script'))}`,
    String(item?.text || '').trim(),
    '',
    clipped,
  ]
    .filter((line, i) => line !== '' || i === 3)
    .join('\n');
}
