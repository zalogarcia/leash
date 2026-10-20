// Daemon authority is authenticated on disk. Workers receive only a per-run
// signing capability; queues hold a one-use proof bound to the entire child.
// Deploy only with the accompanying key-access and ledger-write guard patches.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, createHmac, randomBytes, generateKeyPairSync, sign, verify } from 'node:crypto';
export const GRANT_KEEP_MS = 7 * 24 * 3600_000;
export const GRANT_MAX = 500;
export const WRITE_GRANT_ENV = 'LEASH_WRITE_GRANT';
export const grantHash = token => createHash('sha256').update(String(token)).digest('hex');
// Stable across JSON round trips and across the standalone bg.mjs copy.
export function grantPayload(item) {
  const { writeGrant, ...rest } = item;
  return JSON.stringify(Object.fromEntries(Object.keys(rest).sort().map(k => [k, rest[k]])));
}
export function signWriteGrant(capability, item) {
  const c = JSON.parse(capability);
  return { id: c.id, runId: c.runId, executionId: c.executionId,
    signature: sign(null, Buffer.from(grantPayload(item)), c.privateKey).toString('base64') };
}
export function createWriteGrantStore({ file, now = () => Date.now(), log = () => {} } = {}) {
  if (!file) throw new Error('grant store requires a file');
  const keyFile = file.replace(/\.json$/, '') + '.key';
  // Any key problem fails closed (no grant verifies) and never throws: the
  // daemon builds this store at load, so a throw here would stop it booting.
  // Read or created at FIRST USE, never at load, so importing bridge.mjs stays
  // inert (a suite that imports it created a key where it ran; review 2026-10-13).
  let key; // undefined: not read yet; null: unavailable
  function signingKey() {
    if (key !== undefined) return key;
    key = null;
    try { key = readFileSync(keyFile); }
    catch (e) {
      if (e.code === 'ENOENT') {
        try { const fresh = randomBytes(32); writeFileSync(keyFile, fresh, { flag: 'wx', mode: 0o600 }); key = fresh; }
        catch (e2) { try { key = e2.code === 'EEXIST' ? readFileSync(keyFile) : null; } catch { key = null; } }
      }
      if (!key) log(`signing key unavailable (${e.code || e.message}); no write grant verifies`);
    }
    // A short key (a create cut off mid-write) is guessable: refuse it.
    if (key && key.length < 32) { log('signing key is too short; no write grant verifies'); key = null; }
    return key;
  }
  const mac = data => createHmac('sha256', signingKey()).update(JSON.stringify(data)).digest('hex');
  function read() {
    try {
      const { data, signature } = JSON.parse(readFileSync(file, 'utf8'));
      if (!data || signature !== mac(data)) return { grants: {}, executions: {} };
      return data;
    } catch { return { grants: {}, executions: {} }; }
  }
  // Expired grants and executions refuse anyway (verify, approves): drop them,
  // and keep each map to GRANT_MAX, oldest out first, so the ledger stays small.
  function prune(data) {
    const t = now();
    for (const map of [data.grants, data.executions]) {
      for (const [k, v] of Object.entries(map)) if (!(t - Number(v?.at) < GRANT_KEEP_MS)) delete map[k];
      const keys = Object.keys(map);
      if (keys.length > GRANT_MAX) {
        keys.sort((a, b) => Number(map[a].at) - Number(map[b].at));
        for (const k of keys.slice(0, keys.length - GRANT_MAX)) delete map[k];
      }
    }
    return data;
  }
  function write(data) {
    try {
      if (!signingKey()) return false;
      prune(data);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ data, signature: mac(data) }), { mode: 0o600 });
      renameSync(tmp, file); return true;
    } catch (e) { log(e.message); return false; }
  }
  const api = {
    file,
    // Called at actual fire, before deleting a once/in row. Never from bg.mjs.
    fire(schedule) {
      if (schedule?.run !== true || schedule.allowWrite !== true) return null;
      const data = read(), id = randomBytes(24).toString('hex');
      data.executions[id] = { scheduleId: String(schedule.id), consumed: ['once', 'in'].includes(schedule.kind), at: now() };
      return write(data) ? id : null;
    },
    approves(scheduleId, executionId, schedules) {
      if (!Array.isArray(schedules)) return false;
      const s = schedules.find(s => String(s.id) === String(scheduleId));
      if (s) return s.run === true && s.allowWrite === true;
      const e = read().executions[executionId];
      return !!e && e.consumed === true && e.scheduleId === String(scheduleId) && now() - Number(e.at) < GRANT_KEEP_MS;
    },
    issue(scheduleId, runId, executionId = null) {
      if (scheduleId == null || !runId) return null;
      const data = read(), id = randomBytes(24).toString('hex');
      const keys = generateKeyPairSync('ed25519');
      data.grants[id] = { scheduleId: String(scheduleId), runId: String(runId), executionId,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), at: now(), used: false };
      if (!write(data)) return null;
      return JSON.stringify({ id, runId: String(runId), executionId,
        privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    },
    verify(proof, scheduleId, item) {
      if (!proof || typeof proof !== 'object' || !item) return false;
      const data = read(), g = data.grants[proof.id];
      if (!g || g.used || g.scheduleId !== String(scheduleId) || g.runId !== proof.runId ||
          g.executionId !== proof.executionId || g.executionId !== (item.executionId || null) || now() - g.at >= GRANT_KEEP_MS) return false;
      try { if (!verify(null, Buffer.from(grantPayload(item)), g.publicKey, Buffer.from(proof.signature, 'base64'))) return false; }
      catch { return false; }
      g.used = true;
      return write(data);
    },
    seal(item, runId, { resume = false } = {}) {
      // A mutable wall-guard row cannot mint authority for a fabricated death.
      if (resume && !Object.values(read().grants).some(g => g.runId === String(runId) &&
          g.scheduleId === String(item.scheduleId) && g.executionId === (item.executionId || null))) return item;
      const cap = api.issue(item.scheduleId, runId, item.executionId || null);
      if (cap) item.writeGrant = signWriteGrant(cap, item);
      return item;
    },
    snapshot: read,
  };
  return api;
}
