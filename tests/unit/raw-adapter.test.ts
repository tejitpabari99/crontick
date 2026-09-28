import { describe, expect, it } from 'vitest';
import { RawAdapter } from '../../src/engines/raw-adapter.js';
import type { EngineOptions } from '../../src/engines/types.js';

const options: EngineOptions = {
  command: 'custom-engine',
  engineArgs: ['--batch', '-p'],
  runId: 'run-1',
  jobId: 'job-1',
  dataDir: '/tmp/crontick',
  reuseSession: true,
  args: ['--model', 'fast'],
  env: { CUSTOM_KEY: 'value' },
};

describe('RawAdapter', () => {
  const adapter = new RawAdapter();

  it('preserves generic argv and environment assembly', () => {
    expect(adapter.buildInvocation('hello', options)).toEqual({
      command: 'custom-engine',
      args: ['--batch', '-p', 'hello', '--model', 'fast'],
      env: { CUSTOM_KEY: 'value' },
    });
    expect(adapter.buildInvocation('hello', { ...options, sessionId: 'sess-12345678' }).args)
      .toEqual(['--batch', '-p', 'hello', '--model', 'fast', '--session-id=sess-12345678']);
  });

  it('uses exit code alone for success and extracts a generic session id', () => {
    const success = adapter.parseResult(0, 'session id: sess-12345678', '');
    expect(success).toEqual({ status: 'success', exitCode: 0, sessionId: 'sess-12345678' });
    expect(adapter.resolveSessionId(options, success)).toBe('sess-12345678');
    expect(adapter.parseResult(3, 'session id: sess-12345678', '')).toEqual({
      status: 'failed', exitCode: 3,
    });
    expect(adapter.parseResult(null, '', '')).toEqual({
      status: 'failed', error: 'process exited without code',
    });
  });
});
