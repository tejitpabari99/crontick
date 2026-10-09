import { describe, expect, it } from 'vitest';
import { defaultAutostartDeps } from '../../src/autostart/defaults.js';

describe('defaultAutostartDeps.exec', () => {
  it('captures output larger than the 1 MB execFile default (regression)', async () => {
    const r = await defaultAutostartDeps({}).exec(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(2 * 1024 * 1024);
  });
});
