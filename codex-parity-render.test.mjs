import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { planReply } from './rich-format.mjs';
import { normalizeDashes } from './dash-normalize.mjs';
import { codexFallbackPrefix } from './bg-codex.mjs';
import { codexWritingPrompt } from './codex-writing.mjs';

const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8');
const grab = (name) => {
  const start = source.indexOf(`function ${name}(`);
  const at = source.lastIndexOf('\n', start) + 1;
  const tail = source.slice(at);
  return tail.slice(0, tail.slice(1).search(/\n(?:async function |function |const |let |class |\/\*\*)/) + 1);
};
const sent = [];
const sendResult = new Function('normalizeDashes', 'planReply', 'sendHtmlChunk', 'tg', 'gov', `
const NO_DASHES = true, TG_MSG_LIMIT = 4096, CHAT_ID = 1;
let richOk = false;
${grab('sendResult')}
return sendResult;
`)(normalizeDashes, planReply, async (html) => sent.push(html), async () => {}, () => ({ coolingDown: () => false }));

// THE REAL TEXT of the 11:43 AM relay on 2026-10-07 (a screenshot from the chat). It is the answer of Codex job
// codex-1791386695785, which the old direct-delivery path sent with markdown
// OFF and a token footer: the screenshot shows its tail word for word, from
// "Could not verify because:" down to the three Findings bullets, followed by
// "(141,832 in / 1,054 out tokens)". Verbatim from runs/codex-1791386695785.last.md.
const REPORT_1143 = [
  "Collection is blocked. No PR was created, and nothing was pushed, merged to main, deployed, or migrated.",
  "",
  "Saved the [collection report](/home/user/dev/app-directory-p1/.claude/DIRECTORY-P1-COLLECT-DRAFT.md) and [independent verifier evidence](/home/user/dev/app-directory-p1/.claude/DIRECTORY-P1-VERIFIER.md).",
  "",
  "The worktree began clean at WIP commit `0c70f34e`. These corrections remain unstaged:",
  "",
  "- Removed the proposed schema section. `SCHEMA-PROD.md` now matches cached `origin/main` exactly.",
  "- Added the missing Supabase SDK CORS header.",
  "- Strengthened its regression test.",
  "",
  "Fresh checks ran **inside the sandbox**, so they do not satisfy the required outside-sandbox gate:",
  "",
  "| Check | Result |",
  "|---|---|",
  "| Strict UI typecheck | Exit 0 |",
  "| CI-style build | Exit 0 |",
  "| Full Vitest | 4,794 passed, 1 failed |",
  "| Deno tests | 40 passed, exit 0 |",
  "| Six edge bundle checks | Exit 0 |",
  "| Changed JS/JSX lint | 18 errors, 1 warning |",
  "| SQL proof | 0 of 61 |",
  "| Real HTTP harness | 0 of 16 |",
  "",
  "The Vitest failure, lint diagnostics, and missing-variable build failure reproduced on cached `origin/main` sources. The single Postgres attempt failed with `shmget: Operation not permitted`; no cluster started and no retry occurred.",
  "",
  "The verifier read all three migrations. Static review confirmed additive objects, forced RLS on seven tables, `(SELECT auth.uid())` owner predicates, and inactive jobs. Current upstream and open-PR timestamp ordering remain unproven.",
  "",
  "Git fetch and merge were denied by read-only git metadata. GitHub was unreachable, bridge worker status was unavailable, and no active Claude usage reading could be obtained. The independent **Claude** check remains outstanding.",
  "",
  "## INDEPENDENT VERIFIER",
  "",
  "Verifier agent: qa-agent, Codex  ",
  "Criteria handed over: 1, 2, 3, 4, 5, verbatim  ",
  "Proof source: `.claude/VERIFY.md`, Edge bundles; CORS proof derived from criterion 1  ",
  "Proof command (chosen by the verifier):",
  "```sh",
  "DENO_NO_PACKAGE_JSON=1 deno test --no-config --no-lock --cached-only --allow-env supabase/functions/_shared/directory.test.ts supabase/functions/_shared/directory-database.test.ts supabase/functions/_shared/directory-logo-codec.test.ts supabase/functions/_shared/directory-handlers.test.ts",
  "```",
  "Proof run id: none, this proof has no id  ",
  "Verdict marker: ## ISSUES FOUND  ",
  "Raw output, verbatim excerpt:",
  "```text",
  "CORS preflight permits Supabase SDK headers and errors are readable ... ok (1ms)",
  "ok | 40 passed | 0 failed (261ms)",
  "EXIT=0",
  "```",
  "Re-verify: still failing  ",
  "VERIFY.md gap: no directory pre-merge browser CORS proof signal  ",
  "Could not verify because: outside-sandbox execution, runtime infrastructure, current remote ordering, PR checks, and a Claude verifier were unavailable.",
  "",
  "Verifier verdict, verbatim:",
  "```text",
  "Assessment: PASS WITH CONCERNS",
  "",
  "## ISSUES FOUND",
  "",
  "Status: DONE_WITH_CONCERNS",
  "```",
  "",
  "Remaining collection work requires an environment with writable git metadata and network access: check workers and usage, merge fresh main, establish migration ordering, run outside-sandbox gates, obtain clean QA and Claude verification, commit, push both named branches, open the PR, and wait for checks.",
  "",
  "Findings:",
  "",
  "- **HIGH, corrected:** missing `x-client-info` blocked browser preflight. Fresh verification passed for all six handlers.",
  "- The plan retains the superseded direct vendor credential proposal. Runtime source has no vendor reader; the override controls.",
  "- SQL, real HTTP traffic, browser behavior, and live flow remain unproven.",
].join('\n');

const TOKENS_1143 = { input_tokens: 141832, output_tokens: 1054 };

let pass = 0;
// The OCR of the screenshot, as a guard that the fixture is the text the user saw.
for (const seen of [
  'Could not verify because: outside-sandbox execution, runtime infrastructure, current remote ordering, PR checks, and a Claude verifier were unavailable.',
  'Verifier verdict, verbatim:\n```text\nAssessment: PASS WITH CONCERNS\n\n## ISSUES FOUND\n\nStatus: DONE_WITH_CONCERNS\n```',
  'Remaining collection work requires an environment with writable git metadata and network access:',
  '- **HIGH, corrected:** missing `x-client-info` blocked browser preflight.',
  '- SQL, real HTTP traffic, browser behavior, and live flow remain unproven.',
]) {
  assert.ok(REPORT_1143.includes(seen), `fixture is not the screenshot text: ${seen.slice(0, 60)}`);
  pass += 1;
}
assert.equal(REPORT_1143.length, 3467);
pass += 1;

// What reached the phone, judged on the HTML the sender produced.
// 1. No literal fence marker anywhere: every ``` became a <pre> block.
// 2. No raw heading: no line outside a code block starts with "#".
// 3. A literal "## " survives ONLY as quoted content, which a renderer must
//    not rewrite: inside the code block they were quoted, and in the inline
//    value of "Verdict marker:". Outside those two, none.
// 4. No token count.
const checkRendered = (label) => {
  const html = sent.join('\n');
  assert.ok(html.includes('<pre>'), `${label}: no code block`);
  assert.ok(!html.includes('```'), `${label}: a literal fence survived`);
  const outsideCode = html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
  assert.ok(!/^\s*#{1,6}\s/m.test(outsideCode), `${label}: a raw heading line survived`);
  assert.ok(!outsideCode.replace('Verdict marker: ## ISSUES FOUND', '').includes('## '), `${label}: a literal "## " survived outside quoted content`);
  assert.ok(html.includes('<b>INDEPENDENT VERIFIER</b>'), `${label}: the heading was not rendered`);
  assert.ok(/<pre><code[^>]*>Assessment: PASS WITH CONCERNS\n\n## ISSUES FOUND\n\nStatus: DONE_WITH_CONCERNS<\/code><\/pre>/.test(html), `${label}: the verdict fence is not a code block`);
  assert.ok(!html.includes('141,832'), `${label}: token count`);
  assert.ok(!html.includes('out tokens'), `${label}: token count`);
  pass += 8;
};

// The path that produced 11:43: a finished Codex job delivered straight to
// The owner while every Claude account was walled.
const direct = new Function('sendResult', 'normalizeDashes', 'codexFallbackPrefix', `
const NO_DASHES = true, CODEX_DIRECT_LIMIT = 3500, OWNER_TZ = 'America/Toronto';
const rotationPausedUntil = Date.now() + 3600000, parkedCodexChats = [], PARKED_CODEX_MAX = 10;
const writeFullReport = () => ({ file: 'report.md' });
${grab('deliverCodexDirect')}
return deliverCodexDirect;
`)(sendResult, normalizeDashes, codexFallbackPrefix);
direct('task', { status: 'finished', answer: REPORT_1143, tokens: TOKENS_1143 }, 'codex-1791386695785');
await new Promise((resolve) => setImmediate(resolve));
checkRendered('direct delivery');
assert.ok(sent.join('\n').includes('remain unproven.'), 'the answer was cut short');
pass += 1;

// The Codex chat lane hands its answer to the same sendResult.
sent.length = 0;
await sendResult(REPORT_1143);
checkRendered('chat lane sendResult');


assert.ok(codexWritingPrompt('task').includes('Lead with the answer'));
assert.ok(codexWritingPrompt('task').endsWith('task'));
assert.ok(codexWritingPrompt('task').includes('native agent tools'));
assert.ok(codexWritingPrompt('task').includes('fresh context'));
assert.ok(codexWritingPrompt('task').includes('report the check as unverified'));
assert.equal((source.match(/codexWritingPrompt\(/g) || []).length, 4);
pass += 6;

// /codex <question> stays READ-ONLY (README: "read-only, always"): a one-shot
// `ask` run that continues the chat's thread, never the chat lane, whose
// sandbox follows /yolo (workspace-write plus network by default). When Codex
// is unavailable a healthy Claude takes it as a read-only request.
const ask = source.slice(source.indexOf('// Still read-only when Claude stands in'), source.indexOf('// Still read-only when Claude stands in') + 700);
assert.ok(ask.includes("retryCodexOnClaude(a, { status: 'failed', failure: 'rate_limit' }, { mode: 'ask', cwd: askCwd, images: attached })"));
assert.ok(ask.includes('runCodex(a, {'));
assert.ok(ask.includes("mode: 'ask',"));
assert.ok(ask.includes('trackThread: true,'));
assert.ok(!source.includes('dispatchPrompt(`codex: ${a}`'));
pass += 5;
process.stdout.write(`${pass} passed, 0 failed\n`);
