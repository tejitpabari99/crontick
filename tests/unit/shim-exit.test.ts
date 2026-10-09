import { describe, it, expect } from 'vitest';
import { shimExitCode } from '../../src/utils/shim-exit.js';

describe('shimExitCode', () => {
  it('passes through a numeric exit code', () => {
    expect(shimExitCode(0, null)).toBe(0);
    expect(shimExitCode(3, null)).toBe(3);
  });
  it('maps a crash signal to non-zero so Restart=on-failure restarts it', () => {
    expect(shimExitCode(null, 'SIGKILL')).toBe(137);
    expect(shimExitCode(null, 'SIGSEGV')).toBe(139);
  });
  it('keeps a graceful forwarded stop at 0', () => {
    expect(shimExitCode(null, 'SIGTERM')).toBe(0);
    expect(shimExitCode(null, 'SIGINT')).toBe(0);
  });
});
