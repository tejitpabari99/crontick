import { describe, expect, it } from 'vitest';
import { extractSessionId } from '../src/daemon/prompt-session.js';

describe('extractSessionId', () => {
  it('extracts documented label-based session id forms', () => {
    expect(extractSessionId('session id: sess-abcdefgh')).toBe('sess-abcdefgh');
    expect(extractSessionId('session-id=abc12345')).toBe('abc12345');
    expect(extractSessionId('started copilot session cp-12345678')).toBe('cp-12345678');
    expect(extractSessionId('use --session-id foo_bar-1234')).toBe('foo_bar-1234');
  });

  it('ignores unlabeled UUIDs and short ids', () => {
    expect(extractSessionId('550e8400-e29b-41d4-a716-446655440000')).toBeUndefined();
    expect(extractSessionId('session id: short')).toBeUndefined();
    expect(extractSessionId('no session here')).toBeUndefined();
  });
});
