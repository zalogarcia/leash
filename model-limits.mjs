// Model limits are separate from the account-wide wall. Unknown models
// conservatively count every scoped window.
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function modelFamily(model) {
  const match = String(model || '').toLowerCase().match(/(?:^|[^a-z])(fable|mythos|opus|sonnet|haiku)(?:[^a-z]|$)/);
  return match ? (match[1] === 'mythos' ? 'fable' : match[1]) : null;
}

export function scopedApplies(window, model) {
  const family = modelFamily(model);
  const scope = modelFamily(window?.label);
  return !family || !scope || family === scope;
}

export function usageForModel(usage, model) {
  return usage ? { ...usage, scoped: (usage.scoped || []).filter(w => scopedApplies(w, model)) } : usage;
}

function resetMs(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  return Date.parse(value);
}

export function scopedLimits(usage, now = Date.now()) {
  const models = {};
  for (const w of usage?.scoped || []) {
    const family = modelFamily(w.label) || 'unknown';
    if ( !(w.locked || Number(w.percent) >= 100)) continue;
    const ms = resetMs(w.resetsAt);
    if (Number.isFinite(ms) && ms <= now) continue;
    const until = Math.ceil((Number.isFinite(ms) ? ms : now + 3600_000) / 1000);
    if (!models[family] || until > models[family].until) models[family] = { until, source: 'probe', verifiedAt: new Date(now).toISOString(), percent: Number(w.percent) || 100 };
  }
  return models;
}

export function globalWindowsOpen(usage) {
  return [usage?.fiveHour, usage?.sevenDay].every(w => w && !w.locked && w.percent !== null && w.percent !== undefined && Number.isFinite(Number(w.percent)) && Number(w.percent) < 100);
}

export function modelBlocked(account, model, now = Date.now()) {
  const family = modelFamily(model);
  return Object.entries(account?.modelLimits || {}).some(([key, limit]) => (!family || key === 'unknown' || key === family) && Number(limit.until) * 1000 > now);
}

// An attributed rejection with both global windows open proves a model limit.
export function refusalScope({ model, usage, event = null, text = '', now = Date.now() } = {}) {
  const family = modelFamily(model);
  const info = event?.rate_limit_info;
  if (!family) return null;
  if (info?.status === 'rejected') {
    // A current global wall supersedes an earlier subagent rejection.
    if ([usage?.fiveHour, usage?.sevenDay].some(w => w?.locked || (w?.percent != null && Number(w.percent) >= 100))) return null;
    const windows = info.unifiedWindows || {};
    if (![windows.five_hour, windows.seven_day].every(w => w && Number.isFinite(w.utilization) && w.utilization < 1)) return null;
    if (['five_hour', 'seven_day'].includes(info.rateLimitType)) return null;
    const until = resetMs(info.resetsAt || windows[info.rateLimitType]?.resetsAt);
    return { family, until: Math.ceil((Number.isFinite(until) && until > now ? until : now + 3600_000) / 1000), percent: 100, source: 'rejected scoped window' };
  }
  if (!globalWindowsOpen(usage)) return null;
  const type = info?.status === 'rejected' ? String(info.rateLimitType || '') : '';
  if (type && !/^seven_day_(fable|mythos|opus|sonnet|haiku)$/.test(type)) return null;
  const models = scopedLimits(usage, now);
  const explicit = modelFamily(type || (/weekly|model|limit/i.test(text) ? text : ''));
  if (explicit && explicit !== family) return null;
  if (!models[family] && explicit !== family) return null;
  return { family, ...(models[family] || { until: Math.ceil((now + 3600_000) / 1000), percent: 100 }), source: type ? 'rejected scoped window' : 'scoped usage' };
}

export function writeModelLimits(file, active, limits = {}, { now = Date.now(), fs = { mkdirSync, writeFileSync, renameSync, unlinkSync } } = {}) {
  const models = {};
  for (const [family, value] of Object.entries(limits)) {
    if (Number(value.until) * 1000 > now) models[family] = { blocked: true, until: new Date(Number(value.until) * 1000).toISOString(), percent: value.percent ?? 100 };
  }
  const payload = { updatedAt: new Date(now).toISOString(), active, models };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return payload;
}

// THE ONE DECISION: which model a run starts on, and what the owner is told.
// Every Claude run start asks it with facts the daemon already holds, and only
// its caller writes the lane's decision back, so no second path can decide
// differently from the same evidence. The fallback changes the model, never
// the account: moving the login is the rotation's job.
//   account   the ledger row of the live account, or null when it is not known
//   previous  the lane's last decision, { fallback }
//   carried   a decision a retry or a resume brings, { model: 'opus', told },
//             `told` when the line the owner already saw announced it
// Returns { model, fallback, notice, until }: `fallback` is the decision to
// keep, `notice` is 'fallback', 'restored' or null.
export function decideRunModel({ configured, account = null, previous = null, carried = null, now = Date.now() } = {}) {
  if (modelFamily(configured) !== 'fable') return { model: configured, fallback: false, notice: null, until: null };
  const was = Boolean(previous?.fallback);
  const opus = { model: 'opus', fallback: true, until: account?.modelLimits?.fable?.until ?? null };
  const known = Boolean(account?.name) && !(Number(account.limitedUntil) * 1000 > now);
  // Fable free on a named account answers itself, a carried decision included:
  // a resume held past the Fable reset must not run Opus and announce it.
  if (known && !modelBlocked(account, configured, now)) return { model: configured, fallback: false, notice: was ? 'restored' : null, until: null };
  if (carried?.model === 'opus') return { ...opus, notice: was || carried.told ? null : 'fallback' };
  // Cannot tell, so the last decision stands and nothing is announced: no
  // named account, an account walled for every model, or Fable and Opus both
  // out (the refusal rotation moves the account).
  const keep = { model: was ? 'opus' : configured, fallback: was, notice: null, until: null };
  if (!known) return keep;
  if (!modelBlocked(account, 'opus', now)) return { ...opus, notice: was ? null : 'fallback' };
  return keep;
}
