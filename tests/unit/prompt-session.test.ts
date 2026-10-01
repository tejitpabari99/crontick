import { describe, expect, it } from 'vitest';
import { extractSessionId } from '../../src/daemon/prompt-session.js';

describe('extractSessionId', () => {
  it('extracts documented label-based session id forms', () => {
    expect(extractSessionId('session id: sess-abcdefgh')).toBe('sess-abcdefgh');
    expect(extractSessionId('session-id=abc12345')).toBe('abc12345');
    expect(extractSessionId('started session cp-12345678')).toBe('cp-12345678');
    expect(extractSessionId('use --session-id foo_bar-1234')).toBe('foo_bar-1234');
    expect(extractSessionId('use --session-id=foo_bar-1234')).toBe('foo_bar-1234');
  });

  it('tolerates the [stderr] prefix and surrounding stats lines crontick may add', () => {
    const fullUuid = 'b4823c07-1617-489e-9fe4-820a42ba8677';
    const transcriptTail = [
      '[stderr] ',
      '[stderr] Total duration (API)  4.2s',
      '[stderr] Total tokens          12,345',
      '[stderr] ',
      `[stderr] session id: ${fullUuid}`,
      '',
    ].join('\n');
    expect(extractSessionId(transcriptTail)).toBe(fullUuid);
  });

  it('ignores unlabeled UUIDs and short ids', () => {
    expect(extractSessionId('550e8400-e29b-41d4-a716-446655440000')).toBeUndefined();
    expect(extractSessionId('session id: short')).toBeUndefined();
    expect(extractSessionId('no session here')).toBeUndefined();
  });
});
