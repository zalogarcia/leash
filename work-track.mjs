// work-track.mjs: the daemon's half of the optional Linear work tracker.
//
// OFF BY DEFAULT. Nothing here does anything until the user's config names a
// Linear team and a Linear API key exists (README, "Track jobs in Linear").
// With it off, bg.mjs adds nothing to a brief, the daemon starts no process,
// and every behaviour is exactly what it was before the tracker existed.
//
// With it on, bg.mjs gives every dispatched brief a last line
// `Work item: <key>` and asks `scripts/work.mjs job` to open its Linear issue.
// This module is the rest of that issue's life, from the two moments only the
// daemon sees:
//
//   started(task, runId)   a worker started on the brief: the issue goes to
//                          Running and records the run id (`work.mjs link-run`).
//   reported(task, runId, { output, status })
//                          the report landed: `work.mjs report` reads its
//                          `## Remaining` block and turns each line into an
//                          issue (owed and follow-up lines in Queued, the
//                          waiting-owner lines one card in "Waiting on you"),
//                          then closes the job's issue on a clean finish.
//
// Both are fire and forget: a child process with a time cap, its last line to
// the log and nothing else. The CLI writes each op to its local outbox before
// it touches Linear, so a slow or dead Linear costs the daemon nothing and
// loses nothing. A brief with no `Work item:` line (a chat turn, a schedule, a
// job dispatched with --no-track) is not tracked and costs one regex.
//
// Only the `## Remaining` lines of a report are sent to Linear, never the
// report itself and never the brief: both stay on this machine.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const WORK_CLI = path.join(ROOT, 'scripts', 'work.mjs');

const KEY_LINE = /^Work item: ([a-z0-9][a-z0-9-]{1,120})\b/gm;

/** The work key a brief carries on its `Work item:` line (the last one), or null. */
export function workKeyOf(task) {
  const all = [...String(task ?? '').matchAll(KEY_LINE)];
  return all.length ? all[all.length - 1][1] : null;
}

/** The line bg.mjs ends a tracked brief with. bg.mjs writes the same words
 *  (it imports nothing on purpose); work-tracker.test.mjs holds the two equal. */
export function workKeyLine(key) {
  return `Work item: ${key}. The bridge tracks this job in Linear. End your final report with a "## Remaining" section, one line per item: "- owed: <text>", "- waiting-owner: <text>", "- follow-up: <text>", or the single line "- none". Write each line as "Area: plain title | one plain sentence on what and why", so the owner can read the card on a phone; one "waiting-owner" line per decision the owner actually makes.`;
}

/** The job's own title: its first `# ` heading after the lane rules, else its
 *  first line, 90 characters at most. bg.mjs titles the job the same way. */
export function jobTitleOf(task) {
  const text = String(task ?? '');
  const at = text.indexOf('\n--- TASK ---\n');
  const body = at === -1 ? text : text.slice(at + 14);
  const lines = body.split('\n');
  const heading = lines.find((l) => /^#\s+\S/.test(l));
  const first = lines.find((l) => l.trim() && !/^(-{3,}|Work item: )/.test(l));
  return String(heading ? heading.replace(/^#\s+/, '') : first || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** `<lane>-<startedAt>` for any run id shape (a watchdog id carries a -<pid> tail). */
export function baseRunId(runId) {
  const m = /^([A-Za-z][A-Za-z0-9_]*-\d{10,})(?:-\d+)?$/.exec(String(runId ?? ''));
  return m ? m[1] : String(runId ?? '');
}

const expandHome = (p, home) => (String(p).startsWith('~/') ? path.join(home, String(p).slice(2)) : String(p));

/** The tracker's settings block, from the same layers the daemon's conf() reads:
 *  the BRIDGE_WORK_TRACKER environment variable (JSON), then config.json's
 *  `workTracker`. Anything unreadable is treated as absent. */
export function trackerBlock({ config = {}, env = process.env } = {}) {
  const raw = env.BRIDGE_WORK_TRACKER;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') return v;
    } catch {
      return null;
    }
  }
  const c = config?.workTracker;
  return c && typeof c === 'object' ? c : null;
}

/**
 * The resolved settings, or null when the tracker is off. ON needs all three:
 * a `workTracker` block that is not `"enabled": false`, a `team` (key or name),
 * and a key: LINEAR_API_KEY in the environment or a non-empty key file
 * (`keyFile`, default ~/.config/leash/linear-api-key). The key itself is never
 * read here, only whether one exists.
 */
export function workTrackerSettings({ config = {}, env = process.env, home = env.HOME || '', root = ROOT } = {}) {
  const c = trackerBlock({ config, env });
  if (!c || c.enabled === false) return null;
  const team = typeof c.team === 'string' ? c.team.trim() : '';
  if (!team) return null;
  const keyFile = expandHome(c.keyFile || '~/.config/leash/linear-api-key', home);
  let keyed = Boolean(String(env.LINEAR_API_KEY || '').trim());
  if (!keyed) {
    try {
      keyed = existsSync(keyFile) && statSync(keyFile).size > 0;
    } catch {
      keyed = false;
    }
  }
  if (!keyed) return null;
  const drain = Number(c.dispatchDrainMs);
  return {
    team,
    keyFile,
    stateDir: expandHome(c.stateDir || path.join(root, 'work-tracker'), home),
    states: c.states && typeof c.states === 'object' ? c.states : {},
    cli: path.join(root, 'scripts', 'work.mjs'),
    drainMs: Number.isFinite(drain) && drain >= 0 ? Math.min(drain, 20_000) : 6000,
  };
}

/** The config.json beside the daemon (or BRIDGE_CONFIG), read once by callers. */
export function readBridgeConfig(env = process.env, root = ROOT) {
  try {
    return JSON.parse(readFileSync(env.BRIDGE_CONFIG || path.join(root, 'config.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

/** Runs `node scripts/work.mjs <args>`; null `cli` means the tracker is off. */
export function createWorkTracker({ cli = null, nodeBin = process.execPath, spawn = nodeSpawn, log = (s) => console.log(s), timeoutMs = 90_000 } = {}) {
  const startedRuns = new Set();
  function run(args, input) {
    if (!cli) return null;
    let child;
    try {
      child = spawn(nodeBin, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log(`[work] ${args[0]} not started: ${e.message}`);
      return null;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log(`[work] ${args[0]} ${args[2] || ''} failed to run: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const said = String(code === 0 ? out : err || out).trim().split('\n').pop() || `exit ${code}`;
      log(`[work] ${args[0]} ${args[2] || ''}: ${said.slice(0, 300)}`);
    });
    try {
      child.stdin?.on('error', () => {});
      if (input != null) child.stdin?.write(String(input));
      child.stdin?.end();
    } catch {
      /* the close handler reports it */
    }
    return child;
  }
  return {
    enabled: Boolean(cli),
    started(task, runId) {
      const key = workKeyOf(task);
      const base = baseRunId(runId);
      if (!cli || !key || !runId || startedRuns.has(base)) return null;
      startedRuns.add(base);
      return run(['link-run', '--key', key, '--run', String(runId), '--title', jobTitleOf(task) || key, '--drain-ms', '20000']);
    },
    reported(task, runId, { output = '', status = 'finished' } = {}) {
      const key = workKeyOf(task);
      if (!cli || !key) return null;
      startedRuns.delete(baseRunId(runId));
      return run(['report', '--key', key, '--run', String(runId || ''), '--status', String(status || 'finished'), '--title', jobTitleOf(task) || key, '--stdin', '--drain-ms', '30000'], output);
    },
  };
}
