import { describe, expect, it } from 'vitest';
import { parseConfigValue } from '../../src/utils/config-value.js';

describe('parseConfigValue', () => {
  it('parses JSON scalars, arrays and objects', () => {
    expect(parseConfigValue('600')).toBe(600);
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('null')).toBeNull();
    expect(parseConfigValue('["-p","--verbose"]')).toEqual(['-p', '--verbose']);
    expect(parseConfigValue('{"command":"echo"}')).toEqual({ command: 'echo' });
  });
  it('falls back to the raw string when not JSON', () => {
    expect(parseConfigValue('claude')).toBe('claude');
    expect(parseConfigValue('/usr/bin/x y')).toBe('/usr/bin/x y');
  });
  it('--string forces a string', () => {
    expect(parseConfigValue('123', { string: true })).toBe('123');
    expect(parseConfigValue('true', { string: true })).toBe('true');
  });
});
