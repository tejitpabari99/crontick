import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePromptRunCommand } from '../../src/config.js';
import { RawAdapter } from '../../src/engines/raw-adapter.js';

describe('prompt engine resolution', () => {
  it('keeps the invocation and result parser on the same config snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-engine-snapshot-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({
        defaultEngine: 'custom',
        engines: { custom: { type: 'raw', command: 'first', args: ['-p'] } },
      }));

      const resolved = resolvePromptRunCommand(
        { kind: 'prompt', prompt: 'hello', engine: 'custom', args: [], reuseSession: false },
        { path },
        { runId: 'run-1', jobId: 'job-1', dataDir: dir },
      );

      writeFileSync(path, JSON.stringify({
        defaultEngine: 'custom',
        engines: { custom: { type: 'claude', command: 'second', args: [] } },
      }));

      expect(resolved.invocation).toEqual({ command: 'first', args: ['-p', 'hello'], env: {}, engine: 'custom' });
      expect(resolved.adapter).toBeInstanceOf(RawAdapter);
      expect(resolved.engineOptions).toMatchObject({ command: 'first', engineArgs: ['-p'], runId: 'run-1' });
      expect(resolved.adapter.parseResult(0, 'session id: sess-12345678', '').sessionId).toBe('sess-12345678');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
