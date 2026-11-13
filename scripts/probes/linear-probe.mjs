#!/usr/bin/env node
// scripts/probes/linear-probe.mjs: is every query the work tracker sends one
// the live Linear API accepts? LIVE (it calls api.linear.app with your key),
// free, and it WRITES NOTHING: the reads run for real, and each write is aimed
// at the all-zero id, so Linear refuses it at execution. A refusal there proves
// the query's shape; a schema (validation) error is a real defect.
//
//   node scripts/probes/linear-probe.mjs
//
// Needs the tracker's key and team (README, "Track jobs in Linear"). Prints one
// line per operation and no names, ids or key. Exit 0: every shape valid. Exit
// 1: a schema error (a defect in scripts/work.mjs). Exit 2: blocked (no key, no
// team, or Linear unreachable), nothing proven.
//
// Why it exists: the offline suite runs against a fake Linear, which accepts
// whatever the CLI sends. The first run of this probe found a query the fake
// took and Linear refused ("Query too complex").

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig, workTrackerSettings } from '../../work-track.mjs';
import { Q, linearTransport } from '../work.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const s = workTrackerSettings({ config: readBridgeConfig(process.env, ROOT), env: process.env, root: ROOT });
if (!s) {
  console.log('BLOCKED: the work tracker is off (no team, or no Linear key)');
  process.exit(2);
}
let key = String(process.env.LINEAR_API_KEY || '').trim();
if (!key) {
  try {
    key = readFileSync(s.keyFile, 'utf8').trim();
  } catch {
    key = '';
  }
}
const gql = linearTransport({ key });
const Z = '00000000-0000-0000-0000-000000000000';
const SCHEMA = /Unknown (argument|type|field)|Cannot query field|not defined by type|Expected type|used in position expecting|Variable .* of type|is required|must have a selection|Syntax Error|Query too complex/i;
let schemaErrors = 0;
let blocked = 0;

async function probe(name, query, vars, { write = false } = {}) {
  try {
    const d = await gql(query, vars);
    if (write) {
      console.log(`?? ${name}: Linear accepted a write aimed at the zero id`);
      schemaErrors++;
    } else console.log(`ok ${name}`);
    return d;
  } catch (e) {
    const m = String(e.message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<id>');
    if (SCHEMA.test(m)) {
      console.log(`SCHEMA ${name}: ${m.slice(0, 160)}`);
      schemaErrors++;
    } else if (write && /^Linear 200:/.test(m)) console.log(`ok ${name} (refused at execution: ${m.slice(12, 70)})`);
    else {
      console.log(`BLOCKED ${name}: ${m.slice(0, 120)}`);
      blocked++;
    }
    return null;
  }
}

await probe('viewer', Q.viewer, {});
const teams = await probe('teams', Q.teams, {});
const want = s.team.toLowerCase();
const team = (teams?.teams?.nodes || []).find((x) => x.key.toLowerCase() === want || x.name.toLowerCase() === want);
if (teams && !team) {
  console.log(`BLOCKED: no team "${s.team}" for this key`);
  process.exit(2);
}
const teamId = team?.id || Z;
await probe('team states', Q.teamStates, { id: teamId });
await probe('issue by key', Q.byNeedle, { team: teamId, needle: '"key":"job-probe-never-exists"', after: null });
await probe('open issues', Q.open, { team: teamId, after: null });
await probe('open tracker cards', Q.openTracked, { team: teamId, after: null });
const viewer = (await probe('viewer again, for the comment filter', Q.viewer, {}))?.viewer;
await probe('comments since', Q.comments, { team: teamId, user: viewer?.id || Z, since: new Date(Date.now() - 3600_000).toISOString(), after: null });
await probe('comments in a window', Q.commentsBefore, { team: teamId, user: viewer?.id || Z, since: new Date(Date.now() - 7200_000).toISOString(), before: new Date(Date.now() - 3600_000).toISOString(), after: null });
await probe('issue', Q.issue, { id: Z }, { write: true });
await probe('issue update', Q.update, { id: Z, input: { stateId: Z } }, { write: true });
await probe('comment create', Q.comment, { input: { issueId: Z, body: 'probe' } }, { write: true });
await probe('issue create', Q.create, { input: { teamId: Z, title: 'probe', description: 'probe', stateId: Z } }, { write: true });
await probe('state create', Q.stateCreate, { input: { teamId: Z, name: 'probe', type: 'started', color: '#95a2b3' } }, { write: true });

if (schemaErrors) {
  console.log(`FAIL: ${schemaErrors} schema error(s)`);
  process.exit(1);
}
if (blocked) {
  console.log(`BLOCKED: ${blocked} call(s) did not reach a verdict`);
  process.exit(2);
}
console.log('PASS: every query shape is valid');
process.exit(0);
