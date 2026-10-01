#!/usr/bin/env node
/** CLI entry for `npm run clean:test`. Logic lives in ./clean-test-lib.mjs (shebang-free so vitest can import it). */
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cleanTargets, listTempTargets, real } from './clean-test-lib.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = listTempTargets();
  const result = await cleanTargets(before);
  console.log(`clean:test removed ${before.length - result.dirs.length} temp dir(s) under ${real(tmpdir())}`);
  if (result.pids.length || result.dirs.length) {
    console.error(`clean:test: LEAKS REMAIN pids=[${result.pids}] dirs=[${result.dirs}]`);
    process.exit(1);
  }
}
