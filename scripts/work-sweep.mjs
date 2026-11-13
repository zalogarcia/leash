#!/usr/bin/env node
// scripts/work-sweep.mjs: `work.mjs sweep` with no arguments, for a schedule
// script entry. Prints nothing when nothing needs the chat session, so the
// daemon starts no turn for an empty sweep:
//   node schedule.mjs add every 3h 09:05 --script scripts/work-sweep.mjs "Work sweep"
import { main } from './work.mjs';

main(['sweep']).then((code) => process.exit(code), (e) => {
  process.stderr.write(`work-sweep: ${e?.message || e}\n`);
  process.exit(1);
});
