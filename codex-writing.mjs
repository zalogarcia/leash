// THE REPLY RULES every Codex turn carries, repeated on each turn so a resumed
// thread receives the current rules too.
//
// A Codex reply reaches the same phone a Claude reply does, through the same
// renderer, and the things that made one look broken there were Codex habits,
// not rendering bugs: a raw code fence around prose, an agent contract heading
// pasted as the answer, a token footer. The default below asks for the reply
// shape the chat needs and nothing about any particular person's style.
//
// `codexReplyRules` in config.json replaces the default (your own house style,
// your own delegation rules); an empty string sends the turn with no rules at
// all. bridge.mjs sets it once at boot through setCodexReplyRules.
export const DEFAULT_CODEX_REPLY_RULES =
  'REPLY RULES: Lead with the answer. Explain the result before technical details. Keep agent contract headings, token counts and infrastructure details out of the reply unless the user asks for them. Summarize background reports in your own words; never paste a raw worker report as the reply. Use Markdown code fences only for code the user needs to copy. Preserve code and quoted data exactly. When the task asks for QA, a plan, a verifier or subagents and native agent tools are available, use them; an independent verifier gets a fresh context with only the acceptance criteria, the repo path and its .claude/VERIFY.md. If they are unavailable, report the check as unverified instead of verifying your own work.';

let rules = DEFAULT_CODEX_REPLY_RULES;

/** Replace the rules (a string; '' turns them off). Anything else keeps the default. */
export function setCodexReplyRules(value) {
  if (typeof value === 'string') rules = value.trim();
}

export function codexWritingPrompt(text) {
  const body = String(text ?? '');
  return rules ? `${rules}\n\n${body}` : body;
}
