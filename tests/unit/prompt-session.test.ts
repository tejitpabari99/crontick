import { describe, expect, it } from 'vitest';
import { extractSessionId } from '../../src/daemon/prompt-session.js';

describe('extractSessionId', () => {
  it('extracts documented label-based session id forms', () => {
    expect(extractSessionId('session id: sess-abcdefgh')).toBe('sess-abcdefgh');
    expect(extractSessionId('session-id=abc12345')).toBe('abc12345');
    expect(extractSessionId('started copilot session cp-12345678')).toBe('cp-12345678');
    expect(extractSessionId('use --session-id foo_bar-1234')).toBe('foo_bar-1234');
    expect(extractSessionId('use --session-id=foo_bar-1234')).toBe('foo_bar-1234');
  });

  it('extracts the id from the Copilot CLI resume-hint stats footer (real output form)', () => {
    // Full uuid form, as emitted by Copilot CLI's stats footer on stderr.
    const fullUuid = 'b4823c07-1617-489e-9fe4-820a42ba8677';
    expect(extractSessionId(`Resume     copilot --resume=${fullUuid}`)).toBe(fullUuid);

    // Realistic transcript tail: the [stderr] prefix crontick adds plus the
    // surrounding AI Credits / Tokens stats lines must not interfere.
    const transcriptTail = [
      '[stderr] ',
      '[stderr] Total duration (API)  4.2s',
      '[stderr] Total tokens          12,345',
      '[stderr] AI Credits used       0.03',
      '[stderr] ',
      `[stderr] Resume     copilot --resume=${fullUuid}`,
      '',
    ].join('\n');
    expect(extractSessionId(transcriptTail)).toBe(fullUuid);

    // Maintainer-observed sample (note the [stderr] prefix crontick prepends).
    expect(extractSessionId('[stderr] Resume     copilot --resume=d93fdfe8-8de5-4c93-8eeb-67cc895c7'))
      .toBe('d93fdfe8-8de5-4c93-8eeb-67cc895c7');
  });

  it('ignores unlabeled UUIDs and short ids', () => {
    expect(extractSessionId('550e8400-e29b-41d4-a716-446655440000')).toBeUndefined();
    expect(extractSessionId('session id: short')).toBeUndefined();
    expect(extractSessionId('no session here')).toBeUndefined();
  });
});
