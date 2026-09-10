#!/usr/bin/env node
// CLI over the Telegram bridge's schedule store — lets a Claude session manage
// reminders/tasks in plain English ("remind me every day at 8 to…").
// The bridge daemon reads this file fresh each poll cycle, so changes take
// effect within ~1 minute with no restart.
//
//   node schedule.mjs list
//   node schedule.mjs add daily 08:00 "text"            # every day
//   node schedule.mjs add every 3d 12:00 "text"         # every N days, N 2..365
//   node schedule.mjs add once 2026-07-30 09:30 "text"  # specific date+time
//   node schedule.mjs add in 90m "text"                 # relative: m|h|d
//   node schedule.mjs remove <id>
//   node schedule.mjs update <id> [--at HH:MM|YYYY-MM-DDTHH:MM] [--text "…"] [--run true|false]
//                                 [--every N] [--anchor YYYY-MM-DD]
//
// Flags: --run  → execute the text as a Claude task instead of sending a
//        plain reminder (same as the "run:" prefix in Telegram's /remind).
//        --every N  → turn a daily into an every-N-days item (N 2..365);
//        --every 1 removes the cadence and it goes back to every day.
//        --anchor YYYY-MM-DD  → record that date as the last fire, so the next
//        one lands on anchor + N days. `list` prints that date, so the way to
//        make an every-3d item fire on the 13th is --anchor 2026-09-10.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, describeWhen, everyDays, nextDaily } from './schedule-due.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schedules.json');

const load = () => {
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    return { nextId: 0, items: [] }; // no file yet
  }
  try {
    const d = JSON.parse(raw);
    return { nextId: d.nextId || 0, items: Array.isArray(d.items) ? d.items : [] };
  } catch (e) {
    // Never let a corrupt store look like "no schedules" and get overwritten.
    console.error(`schedules.json is corrupt (${e.message}) — refusing to overwrite it.`);
    console.error(`Inspect or move ${FILE}, then retry.`);
    process.exit(1);
  }
};
const save = (s) => {
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, FILE);
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// The cadence is the one thing you cannot read off "every 3d 12:00" alone, so
// an every-N-days item shows the date it actually lands on next.
const fmt = (s) => {
  const next = nextDaily(s, localToday());
  return `#${s.id} · ${describeWhen(s)}${next ? ` (next ${next})` : ''} · ${s.run ? 'run' : 'remind'} · ${s.text}`;
};
const die = (m) => {
  console.error(m);
  process.exit(1);
};
const parseEvery = (v, usage) => {
  const n = Number(v);
  if (!/^\d+$/.test(String(v ?? '')) || !Number.isInteger(n) || n < 2 || n > 365) die(usage);
  return n;
};

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'list').toLowerCase();
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const hasFlag = (name) => argv.includes(`--${name}`);
// Which flags own the token after them. `--run` is bare by default and only
// owns the next token when that token is literally true or false, the same rule
// `update` documents below. Treating every flag as value-taking made
// `add daily 08:00 --run "text"` swallow the text and die with "missing text".
const VALUE_FLAGS = new Set(['at', 'text', 'every', 'anchor']);
const takesValue = (tok, next) => {
  if (!tok?.startsWith('--')) return false;
  const name = tok.slice(2);
  return VALUE_FLAGS.has(name) || (name === 'run' && (next === 'true' || next === 'false'));
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && takesValue(argv[i - 1], a)));

const store = load();

if (cmd === 'list') {
  console.log(store.items.length ? store.items.map(fmt).join('\n') : 'No schedules.');
} else if (cmd === 'add') {
  const kind = (positional[1] || '').toLowerCase();
  let item;
  if (kind === 'daily' || kind === 'every') {
    // `every` is a daily with a cadence: same kind, same lastFired rules, so
    // nothing that reads the store breaks on it. A daemon older than this
    // feature does not CRASH on `every`, it ignores it and fires the item every
    // day, so an every-N item is only safe to add once the daemon is restarted.
    const every = kind === 'every' ? parseEvery((positional[2] || '').match(/^(\d+)d$/i)?.[1], 'add every <N>d <HH:MM> "text"  (N 2..365)') : 1;
    const atIdx = kind === 'every' ? 3 : 2;
    const at = positional[atIdx];
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at || ''))
      die(kind === 'every' ? 'add every <N>d <HH:MM> "text"' : 'add daily <HH:MM> "text"');
    item = { kind: 'daily', at: at.padStart(5, '0'), text: positional.slice(atIdx + 1).join(' ') };
    if (every > 1) item.every = every;
    const now = new Date().toTimeString().slice(0, 5);
    if (now >= item.at) item.lastFired = localToday();
  } else if (kind === 'once') {
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(positional[2] || '');
    const timeIdx = hasDate ? 3 : 2;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(positional[timeIdx] || '')) die('add once [YYYY-MM-DD] <HH:MM> "text"');
    let when;
    if (hasDate) {
      when = new Date(`${positional[2]}T${positional[timeIdx].padStart(5, '0')}:00`);
    } else {
      const [h, m] = positional[timeIdx].split(':');
      when = new Date();
      when.setHours(+h, +m, 0, 0);
      if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    }
    if (isNaN(when.getTime())) die('unparseable date/time');
    item = { kind: 'once', at: when.getTime(), text: positional.slice(timeIdx + 1).join(' ') };
  } else if (kind === 'in') {
    const m = (positional[2] || '').match(/^(\d+)(m|h|d)$/i);
    if (!m) die('add in <N>m|h|d "text"');
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
    item = { kind: 'once', at: Date.now() + Number(m[1]) * mult, text: positional.slice(3).join(' ') };
  } else {
    die('add daily|every|once|in …');
  }
  if (!item.text) die('missing text');
  if (item.kind === 'once' && item.at <= Date.now())
    die(`${new Date(item.at).toLocaleString()} is in the past — nothing scheduled; give a future date/time`);
  if (hasFlag('run')) item.run = true;
  item.id = store.nextId = (store.nextId || 0) + 1;
  store.items.push(item);
  save(store);
  console.log(`added ${fmt(item)}`);
} else if (cmd === 'remove') {
  const id = Number(positional[1]);
  const before = store.items.length;
  store.items = store.items.filter((s) => s.id !== id);
  if (store.items.length === before) die(`no schedule #${id}`);
  save(store);
  console.log(`removed #${id}`);
} else if (cmd === 'update') {
  const id = Number(positional[1]);
  const item = store.items.find((s) => s.id === id);
  if (!item) die(`no schedule #${id}`);
  const at = flag('at');
  if (at) {
    if (item.kind === 'daily') {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) die('daily --at wants HH:MM');
      item.at = at.padStart(5, '0');
      // For a cadence item lastFired is the ANCHOR, not just a "fired today"
      // latch: clearing it here would re-phase the schedule and fire it up to
      // N-1 days early. --anchor is how you move the phase on purpose.
      if (everyDays(item) === 1) delete item.lastFired;
      // Moving a daily to a time already past today must not fire immediately.
      if (!item.lastFired && new Date().toTimeString().slice(0, 5) >= item.at) item.lastFired = localToday();
    } else {
      let when;
      if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) {
        // bare HH:MM on a one-off → today, or tomorrow if already past (same as `add once`)
        const [h, m] = at.split(':');
        when = new Date();
        when.setHours(+h, +m, 0, 0);
        if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
      } else {
        when = new Date(at);
      }
      if (isNaN(when.getTime())) die('once --at wants HH:MM or YYYY-MM-DDTHH:MM');
      if (when.getTime() <= Date.now())
        die(`${when.toLocaleString()} is in the past — not moved; give a future date/time`);
      item.at = when.getTime();
    }
  }
  // Cadence. `--every 1` is how you go back to plain daily, so 1 is legal here
  // even though `add every 1d` is not: removing a field is not the same ask as
  // creating one that means nothing.
  if (argv.includes('--every')) {
    const every = flag('every');
    if (item.kind !== 'daily') die('--every only applies to a daily schedule');
    if (String(every) === '1') delete item.every;
    else item.every = parseEvery(every, 'update <id> --every <N>  (N 2..365, or 1 to go back to daily)');
  }
  // The anchor is the last fire, so the next one is anchor + N days. Read after
  // --every and --at on purpose: setting both in one call is the normal way to
  // convert an item, and the anchor is the more specific instruction of the two.
  if (argv.includes('--anchor')) {
    const anchor = flag('anchor');
    if (item.kind !== 'daily') die('--anchor only applies to a daily schedule');
    // On a plain daily an anchor is unreachable: it fires every day whatever
    // lastFired says. Accepting it would report success for nothing.
    if (everyDays(item) === 1) die('--anchor needs a cadence: set --every <N> in the same call, or first');
    // addDays round-trips through the same parser the daemon uses, which is
    // what catches a date that only LOOKS real: new Date("2026-02-30") does not
    // throw, it silently becomes March 2nd.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchor ?? '')) || addDays(anchor, 0) !== anchor)
      die('update <id> --anchor YYYY-MM-DD  (a real date to count from; the next fire is that date plus N days)');
    item.lastFired = anchor;
  }
  const text = flag('text');
  if (text) item.text = text;
  // `--run` bare = on (matches `add`); `--run true|false` explicit; `--no-run` off.
  // Never consume the next token unless it's literally true/false, or a flag
  // following --run would be silently read as its value.
  if (argv.includes('--no-run')) delete item.run;
  else if (argv.includes('--run')) {
    const v = flag('run');
    if (v === 'false') delete item.run;
    else item.run = true;
  }
  save(store);
  console.log(`updated ${fmt(item)}`);
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
}
