// linear-comments.mjs: what the daemon says and does around the owner's
// comments on Linear cards, when the optional work tracker is on (README,
// "Track jobs in Linear"). Pure: no paths, no process, no Telegram. bridge.mjs
// runs the reader (`node scripts/work.mjs comments`) and hands its output here.
//
// A comment on a card is an answer: the reader collects every new one into ONE
// batch, so ten replies on ten cards cost one chat turn, not ten. It runs on
// /comments and from a schedule script entry (scripts/work-comments.mjs). A
// comment stays in the batch on every read until the chat session runs the
// `comments --done <time>` line the batch ends with, so a batch that never
// reached a turn is shown again, not lost.

const BATCH_RE = /^\[Linear comments by /;

/** Does this reader output carry a batch of comments on its first line? */
export const isCommentsBatch = (output) => BATCH_RE.test(String(output ?? '').trimStart());

/** The chat turn for a batch: daemon authored, so it never reads as the owner typing. */
export function commentsBatchPrompt({ output, trigger = 'a schedule slot', ownerName = 'the owner' }) {
  const body = String(output ?? '').trim();
  if (!body) return null;
  return `[Daemon authored, not ${ownerName} typing: their comments on Linear cards, read at ${trigger}.]\n${body}`;
}

const line = (glyph, text) => `${glyph} Linear comments · ${text}`;

/**
 * What /comments does with one run of the reader: { prompt } starts one chat
 * turn, { line } is one line from the daemon with no model turn. Exit 3 means
 * another run holds the reader's lock. Nothing read is lost on any path: a
 * comment leaves the pending list only on `comments --done`.
 */
export function commentsCommandResult({ code = 0, stdout = '', stderr = '', ownerName = 'the owner', enabled = true }) {
  if (!enabled) return { line: line('💬', 'the work tracker is off (README, "Track jobs in Linear")'), log: 'comments_off' };
  const body = String(stdout ?? '').trim();
  // A batch that reached stdout is delivered, whatever else happened after it.
  if (isCommentsBatch(body)) return { prompt: commentsBatchPrompt({ output: body, trigger: '/comments', ownerName }) };
  if (code === 3) return { line: line('💬', 'another run is reading them now'), log: 'comments_busy' };
  if (code) {
    const why = String(stderr ?? '').trim().split('\n').pop().replace(/\s+/g, ' ').slice(0, 200) || `exit ${code}`;
    return { line: line('⚠️', `not read: ${why} · nothing is lost, the next run reads them`), log: `comments_failed exit=${code}` };
  }
  return { line: line('💬', 'none new'), log: 'comments_none_new' };
}
