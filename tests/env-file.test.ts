import { describe, it, expect } from 'vitest';
import { parseEnvFile } from '../src/daemon/runner.js';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores # comments', () => {
    const result = parseEnvFile('# comment\nFOO=bar\n# another comment\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    expect(parseEnvFile('FOO="hello world"')).toEqual({ FOO: 'hello world' });
  });

  it('handles single-quoted values', () => {
    expect(parseEnvFile("FOO='hello world'")).toEqual({ FOO: 'hello world' });
  });

  it('handles empty values', () => {
    expect(parseEnvFile('FOO=')).toEqual({ FOO: '' });
  });

  it('skips blank lines', () => {
    expect(parseEnvFile('\n\nFOO=bar\n\n')).toEqual({ FOO: 'bar' });
  });

  it('skips lines without =', () => {
    expect(parseEnvFile('NOEQUALS\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('trims key whitespace', () => {
    expect(parseEnvFile('  FOO  =bar')).toEqual({ FOO: 'bar' });
  });
});
