'use strict';
// fixtures/mock-engine.cjs — deterministic mock prompt engine for harness
// CJS (.cjs) so `node mock-engine.cjs` works regardless of package "type":"module"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
const prompt = process.argv[2] ?? '';
const rest = process.argv.slice(3);
const sessionArg = rest.find((a) => a.startsWith('--session-id='));

console.log(`[mock-engine] argv=${JSON.stringify(rest)}`);
console.log(`[mock-engine] prompt=${prompt}`);
if (sessionArg) console.log(`[mock-engine] received ${sessionArg}`);

const writeMatch = /WRITE_FILE:(\S+)/.exec(prompt);
if (writeMatch) {
  fs.writeFileSync(writeMatch[1], prompt, 'utf8');
}

const sleepMatch = /SLEEP:(\d+)/.exec(prompt);
if (sleepMatch) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(sleepMatch[1]) * 1000);
}

if (/FAIL_NONZERO/.test(prompt)) {
  console.error('[mock-engine] simulated engine failure');
  process.exit(7);
}

if (!sessionArg) {
  console.log('[mock-engine] session-id: qa-mock-session-0001234');
}

process.exit(0);
