import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/engines/claude-adapter.js';
import { claudeConfigPath, isFolderTrusted, trustFolder, type TrustFs } from '../../src/engines/claude-trust.js';
import { getEngineAdapter } from '../../src/engines/registry.js';
import { CrontickError } from '../../src/errors.js';
import { terminalTrustPromptIo, withTrustPrompt } from '../../src/cli/trust-prompt.js';

/** In-memory TrustFs; tests mutate `files` to simulate Claude rewriting the file. */
function fakeFs(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, { text, mtimeMs: 1, mode: 0o100644 }]));
  const writes: string[] = [];
  const fs: TrustFs = {
    readFileSync(path) {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return file.text;
    },
    writeFileSync(path, data, options) {
      files.set(path, { text: data, mtimeMs: 2, mode: options.mode });
      writes.push(path);
    },
    renameSync(from, to) {
      const file = files.get(from);
      if (!file) throw new Error('ENOENT rename');
      files.set(to, { ...file, mtimeMs: 3 });
      files.delete(from);
    },
    unlinkSync(path) { files.delete(path); },
    chmodSync(path, mode) {
      const file = files.get(path);
      if (file) file.mode = mode;
    },
    statSync(path) {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: file.mtimeMs, size: file.text.length, mode: file.mode };
    },
    realpathSync(path) { return path; },
  };
  return { fs, files, writes };
}

const HOME = '/home/tester';
const CONFIG = `${HOME}/.claude.json`;
const deps = (fs: TrustFs, env: NodeJS.ProcessEnv = {}) => ({ fs, env, homedir: () => HOME });

describe('claudeConfigPath', () => {
  it('uses CLAUDE_CONFIG_DIR when set, else ~/.claude.json', () => {
    expect(claudeConfigPath({ env: {}, homedir: () => HOME })).toBe(CONFIG);
    expect(claudeConfigPath({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, homedir: () => HOME })).toBe('/cfg/.claude.json');
  });
});

describe('isFolderTrusted', () => {
  const config = JSON.stringify({
    projects: {
      '/work/trusted': { hasTrustDialogAccepted: true },
      '/work/declined': { hasTrustDialogAccepted: false },
      '/home/tester': { hasTrustDialogAccepted: true },
    },
  });

  it('trusts the exact folder and any descendant of a trusted ancestor (home included)', () => {
    const { fs } = fakeFs({ [CONFIG]: config });
    expect(isFolderTrusted('/work/trusted', deps(fs))).toBe(true);
    expect(isFolderTrusted('/work/trusted/sub/dir', deps(fs))).toBe(true);
    expect(isFolderTrusted('/home/tester/projects/x', deps(fs))).toBe(true);
  });

  it('does not trust declined, unknown, or unrelated folders', () => {
    const { fs } = fakeFs({ [CONFIG]: config });
    expect(isFolderTrusted('/work/declined', deps(fs))).toBe(false);
    expect(isFolderTrusted('/work/other', deps(fs))).toBe(false);
    expect(isFolderTrusted('/work', deps(fs))).toBe(false);
  });

  it('also checks the symlink-resolved path', () => {
    const { fs } = fakeFs({ [CONFIG]: config });
    fs.realpathSync = (path) => (path === '/link/to/trusted' ? '/work/trusted' : path);
    expect(isFolderTrusted('/link/to/trusted', deps(fs))).toBe(true);
  });

  it('treats a missing, unreadable or non-JSON config as untrusted', () => {
    expect(isFolderTrusted('/work/trusted', deps(fakeFs({}).fs))).toBe(false);
    expect(isFolderTrusted('/work/trusted', deps(fakeFs({ [CONFIG]: '{ nope' }).fs))).toBe(false);
    expect(isFolderTrusted('/work/trusted', deps(fakeFs({ [CONFIG]: '[]' }).fs))).toBe(false);
  });

  it('reads from CLAUDE_CONFIG_DIR when set', () => {
    const { fs } = fakeFs({ '/cfg/.claude.json': config });
    expect(isFolderTrusted('/work/trusted', deps(fs, { CLAUDE_CONFIG_DIR: '/cfg' }))).toBe(true);
    expect(isFolderTrusted('/work/trusted', deps(fs))).toBe(false);
  });
});

describe('trustFolder', () => {
  it('sets only the target flag, preserving every other key and the existing entry byte-for-byte semantically', () => {
    const original = {
      numStartups: 42,
      theme: 'dark',
      mcpServers: { a: { command: 'x' } },
      projects: {
        '/work/other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'], extra: { k: [1, 2] } },
        '/work/declined': { hasTrustDialogAccepted: false, allowedTools: ['Read'], history: ['h'] },
      },
    };
    const { fs, files } = fakeFs({ [CONFIG]: JSON.stringify(original, null, 4) });
    trustFolder('/work/declined', deps(fs));
    trustFolder('/work/new-folder', deps(fs));
    const text = files.get(CONFIG)!.text;
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    const result = JSON.parse(text);
    expect(result).toEqual({
      ...original,
      projects: {
        '/work/other': original.projects['/work/other'],
        '/work/declined': { hasTrustDialogAccepted: true, allowedTools: ['Read'], history: ['h'] },
        '/work/new-folder': { allowedTools: [], hasTrustDialogAccepted: true },
      },
    });
    expect([...files.keys()]).toEqual([CONFIG]); // temp file renamed away
  });

  it('creates the file (mode 0600) when it does not exist', () => {
    const { fs, files } = fakeFs({});
    trustFolder('/work/fresh', deps(fs));
    expect(JSON.parse(files.get(CONFIG)!.text)).toEqual({ projects: { '/work/fresh': { allowedTools: [], hasTrustDialogAccepted: true } } });
    expect(files.get(CONFIG)!.mode & 0o777).toBe(0o600);
  });

  it('aborts with CLAUDE_CONFIG_UNREADABLE and leaves a non-JSON file untouched', () => {
    const { fs, files, writes } = fakeFs({ [CONFIG]: '{ not json' });
    try {
      trustFolder('/work/x', deps(fs));
      expect.unreachable();
    } catch (err) {
      expect((err as CrontickError).code).toBe('CLAUDE_CONFIG_UNREADABLE');
    }
    expect(files.get(CONFIG)!.text).toBe('{ not json');
    expect(writes).toEqual([]);
  });

  it('retries the read-modify-write when the file changes underneath it, keeping the concurrent change', () => {
    const { fs, files } = fakeFs({ [CONFIG]: JSON.stringify({ projects: {} }) });
    // Simulate Claude rewriting the file between our read and our pre-rename stat guard.
    const realStat = fs.statSync.bind(fs);
    let statCalls = 0;
    fs.statSync = (path) => {
      if (path === CONFIG && ++statCalls === 2) {
        files.set(CONFIG, { text: JSON.stringify({ projects: {}, claudeWroteThis: true }), mtimeMs: 9, mode: 0o100600 });
      }
      return realStat(path);
    };
    trustFolder('/work/x', deps(fs));
    const result = JSON.parse(files.get(CONFIG)!.text);
    expect(result.claudeWroteThis).toBe(true);
    expect(result.projects['/work/x'].hasTrustDialogAccepted).toBe(true);
  });

  it('gives up with CLAUDE_CONFIG_BUSY (changing nothing) when the file never settles', () => {
    const { fs, files } = fakeFs({ [CONFIG]: JSON.stringify({ projects: {} }) });
    let mtime = 10;
    const realStat = fs.statSync.bind(fs);
    fs.statSync = (path) => {
      const stat = realStat(path);
      return path === CONFIG ? { ...stat, mtimeMs: mtime++ } : stat;
    };
    expect(() => trustFolder('/work/x', deps(fs))).toThrow(/CLAUDE_CONFIG_BUSY|kept changing/);
    expect(JSON.parse(files.get(CONFIG)!.text)).toEqual({ projects: {} });
    expect([...files.keys()]).toEqual([CONFIG]);
  });
});

describe('engine adapter hooks', () => {
  it('Claude implements the trust hooks, honoring CLAUDE_CONFIG_DIR via ctx.env; raw does not', () => {
    const { fs } = fakeFs({ '/cfg/.claude.json': JSON.stringify({ projects: { '/ok': { hasTrustDialogAccepted: true } } }) });
    const adapter = new ClaudeAdapter({ fs, homedir: () => HOME });
    expect(adapter.isFolderTrusted('/ok/sub', { env: { CLAUDE_CONFIG_DIR: '/cfg' } })).toBe(true);
    expect(adapter.isFolderTrusted('/nope', { env: { CLAUDE_CONFIG_DIR: '/cfg' } })).toBe(false);
    const raw = getEngineAdapter('raw');
    expect(raw.isFolderTrusted).toBeUndefined();
    expect(raw.trustFolder).toBeUndefined();
    expect(typeof getEngineAdapter('claude').isFolderTrusted).toBe('function');
  });
});

describe('CLI trust prompt', () => {
  const required = () => new CrontickError('TRUST_REQUIRED', 'not trusted', { cwd: '/work/x', folders: ['/work/x'], engine: 'claude' });

  it('on a TTY, y retries with trustFolder:true; the question names the folder', async () => {
    const asked: string[] = [];
    const calls: boolean[] = [];
    const result = await withTrustPrompt(async (trust) => {
      calls.push(trust);
      if (!trust) throw required();
      return 'created';
    }, { io: { interactive: true, ask: async (q) => { asked.push(q); return 'y'; } } });
    expect(result).toBe('created');
    expect(calls).toEqual([false, true]);
    expect(asked).toEqual(['Folder /work/x is not trusted by Claude. Trust it? (y/N) ']);
  });

  it('on a TTY, anything but y aborts and nothing is retried', async () => {
    for (const answer of ['', 'n', 'no', 'maybe']) {
      const calls: boolean[] = [];
      await expect(withTrustPrompt(async (trust) => {
        calls.push(trust);
        throw required();
      }, { io: { interactive: true, ask: async () => answer } })).rejects.toMatchObject({ code: 'TRUST_DECLINED' });
      expect(calls).toEqual([false]);
    }
  });

  it('without a TTY the TRUST_REQUIRED error is rethrown without asking', async () => {
    let asked = false;
    await expect(withTrustPrompt(async () => { throw required(); }, { io: { interactive: false, ask: async () => { asked = true; return 'y'; } } }))
      .rejects.toMatchObject({ code: 'TRUST_REQUIRED' });
    expect(asked).toBe(false);
  });

  it('--trust-folder answers yes up front and other errors pass through', async () => {
    const seen: boolean[] = [];
    await withTrustPrompt(async (trust) => { seen.push(trust); }, { trustFolder: true, io: { interactive: false, ask: async () => 'n' } });
    expect(seen).toEqual([true]);
    await expect(withTrustPrompt(async () => { throw new Error('boom'); }, { io: { interactive: true, ask: async () => 'y' } })).rejects.toThrow('boom');
  });

  it('terminalTrustPromptIo reads the answer from the given streams and reports non-TTY streams as non-interactive', async () => {
    const input = Object.assign(Readable.from(['yes\n']), { isTTY: false });
    const chunks: string[] = [];
    const output = Object.assign(new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } }), { isTTY: false });
    const io = terminalTrustPromptIo(input, output);
    expect(io.interactive).toBe(false);
    expect(await io.ask('Q? ')).toBe('yes');
    expect(chunks.join('')).toContain('Q? ');
  });
});
