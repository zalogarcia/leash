#!/usr/bin/env node
// scripts/work-comments.mjs: `work.mjs comments` with no arguments, for a
// schedule script entry. Prints the owner's new comments on Linear cards as one
// batch, or nothing:
//   node schedule.mjs add every 2h 09:10 --script scripts/work-comments.mjs "Linear comments"
import { main } from './work.mjs';

main(['comments']).then((code) => process.exit(code), (e) => {
  process.stderr.write(`work-comments: ${e?.message || e}\n`);
  process.exit(1);
});
