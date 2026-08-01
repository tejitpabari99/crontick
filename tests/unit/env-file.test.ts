import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CrontickError } from '../../src/errors.js';
import { parseEnvFile, readEnvFileForAction } from '../../src/daemon/env-file.js';

const SCRATCH_ROOT = resolve('.crontick', 'env-file-tests');

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

describe('readEnvFileForAction', () => {
  function makeDir(prefix: string): string {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const dir = join(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('reads an absolute env file path', () => {
    const dir = makeDir('absolute');
    const envFilePath = join(dir, 'job.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');

    try {
      expect(readEnvFileForAction({ kind: 'exec', envFile: envFilePath })).toEqual({
        path: envFilePath,
        vars: { FOO: 'bar' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative env file against action.cwd', () => {
    const dir = makeDir('cwd');
    const envFilePath = join(dir, 'nested.env');
    writeFileSync(envFilePath, 'FOO=bar\nBAZ=qux\n', 'utf-8');

    try {
      expect(readEnvFileForAction({ kind: 'exec', cwd: dir, envFile: 'nested.env' })).toEqual({
        path: envFilePath,
        vars: { FOO: 'bar', BAZ: 'qux' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative env file against the provided process cwd fallback', () => {
    const dir = makeDir('process-cwd');
    const envFilePath = join(dir, 'process.env');
    writeFileSync(envFilePath, 'HELLO=world\n', 'utf-8');

    try {
      expect(readEnvFileForAction({ kind: 'exec', envFile: 'process.env' }, dir)).toEqual({
        path: envFilePath,
        vars: { HELLO: 'world' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the resolved path when the env file is missing', () => {
    const dir = makeDir('missing');
    const envFilePath = join(dir, 'missing.env');

    try {
      const error = (() => {
        try {
          readEnvFileForAction({ kind: 'exec', cwd: dir, envFile: 'missing.env' });
          return undefined;
        } catch (err) {
          return err;
        }
      })();

      expect(error).toBeInstanceOf(CrontickError);
      expect(error).toMatchObject({
        code: 'ENV_FILE_ERROR',
        message: expect.stringContaining(envFilePath),
        details: expect.objectContaining({ path: envFilePath }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it('reports the resolved path when the env file path is unreadable', () => {
    const dir = makeDir('unreadable');
    const envFilePath = join(dir, 'env-dir');
    mkdirSync(envFilePath, { recursive: true });

    try {
      const error = (() => {
        try {
          readEnvFileForAction({ kind: 'exec', cwd: dir, envFile: 'env-dir' });
          return undefined;
        } catch (err) {
          return err;
        }
      })();

      expect(error).toBeInstanceOf(CrontickError);
      expect(error).toMatchObject({
        code: 'ENV_FILE_ERROR',
        message: expect.stringContaining(envFilePath),
        details: expect.objectContaining({ path: envFilePath }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
