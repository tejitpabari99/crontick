import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { ClaudeAdapter } from '../../src/engines/claude-adapter.js';
import {
  CLAUDE_HOOK_HELPER_SOURCE, buildClaudeHookCommand, claudeHookHelperPath, ensureClaudeHookHelper, readClaudeHookTranscriptPath,
} from '../../src/claude-completion-marker.js';
import { redactSettingsArg } from '../../src/daemon/runner.js';
import { isUnsafeSessionId, resolveTranscriptPath } from '../../src/engines/claude-transcript.js';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { fakeClaudeEngineConfig } from '../helpers/fake-claude.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Claude invocation', () => {
  const adapter = new ClaudeAdapter();
  const options = {
    command: 'claude', engineArgs: [], runId: 'run-1', jobId: 'job-1', dataDir: '',
    reuseSession: false, args: ['--max-budget-usd', '1'], env: { SAMPLE: 'yes' },
  };

  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'crontick-inv-')); options.dataDir = baseDir; });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('assigns a UUID and builds stream-json argv for a fresh run', () => {
    const invocation = adapter.buildInvocation('do work', options);
    expect(invocation.sessionId).toMatch(uuidPattern);
    expect(invocation).toMatchObject({ command: 'claude', env: { SAMPLE: 'yes' } });
    expect(invocation.args.slice(0, -1)).toEqual([
      '-p', 'do work', '--output-format', 'stream-json', '--verbose',
      '--session-id', invocation.sessionId, '--max-budget-usd', '1', '--settings',
    ]);
    expect(JSON.parse(invocation.args.at(-1)!)).toHaveProperty('hooks.SessionEnd');
  });

  it('resumes the given session without assigning another ID', () => {
    const sessionId = '94697a61-f71d-450b-87bb-a82463a2a6b1';
    const invocation = adapter.buildInvocation('continue', { ...options, sessionId });
    expect(invocation.sessionId).toBe(sessionId);
    expect(invocation.args.slice(0, -1)).toEqual([
      '-p', 'continue', '--output-format', 'stream-json', '--verbose',
      '--resume', sessionId, '--max-budget-usd', '1', '--settings',
    ]);
    expect(JSON.parse(invocation.args.at(-1)!)).toHaveProperty('hooks.SessionEnd');
  });

  it('registers an ephemeral SessionEnd hook that writes the run marker from hook stdin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-hook-'));
    try {
      const invocation = adapter.buildInvocation('do work', { ...options, dataDir: dir });
      const settings = JSON.parse(invocation.args.at(-1)!) as {
        hooks: { SessionEnd: Array<{ hooks: Array<{ type: string; command: string }> }> };
      };
      const hook = settings.hooks.SessionEnd[0]?.hooks[0];
      expect(hook?.type).toBe('command');
      expect(hook!.command).not.toMatch(/eval\(|base64/i);
      expect(hook!.command).toContain(claudeHookHelperPath(dir));
      const result = spawnSync(hook!.command, {
        shell: true,
        input: JSON.stringify({ exit_status: 0, session_id: invocation.sessionId }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'runs', 'run-1.claude-hook.json'), 'utf8')))
        .toEqual({ exitStatus: 0, sessionId: invocation.sessionId, transcriptPath: null });
      // SessionEnd hook input carries transcript_path (verified against Claude Code 2.1.286): record it.
      const transcript = '/home/u/.claude/projects/-w/abc.jsonl';
      const withPath = spawnSync(hook!.command, {
        shell: true,
        input: JSON.stringify({ session_id: invocation.sessionId, transcript_path: transcript, hook_event_name: 'SessionEnd', reason: 'other' }),
        encoding: 'utf8',
      });
      expect(withPath.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'runs', 'run-1.claude-hook.json'), 'utf8')).transcriptPath).toBe(transcript);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readClaudeHookTranscriptPath returns a non-empty string path for the expected session regardless of exitStatus', () => {
    const read = (marker: unknown, sid = 'sid') => readClaudeHookTranscriptPath('/d', 'run-1', sid, () => JSON.stringify(marker));
    expect(read({ exitStatus: null, sessionId: 'sid', transcriptPath: '/t/x.jsonl' })).toBe('/t/x.jsonl');
    expect(read({ exitStatus: null, sessionId: 'sid', transcriptPath: '/t/x.jsonl' }, 'other')).toBeUndefined();
    for (const transcriptPath of [null, '', 5]) expect(read({ exitStatus: 0, sessionId: 'sid', transcriptPath })).toBeUndefined();
    expect(readClaudeHookTranscriptPath('/d', 'run-1', 'sid', () => { throw new Error('missing'); })).toBeUndefined();
  });
});

describe('SessionEnd hook helper', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'crontick-helper-')); dirs.push(d); return d; };
  const opts = { command: 'claude', engineArgs: [], runId: 'run-1', jobId: 'job-1', reuseSession: false, args: [], env: {} };

  it('writes fixed content idempotently and rewrites a tampered helper', () => {
    const dir = tmp();
    const path = ensureClaudeHookHelper(dir)!;
    expect(path).toBe(claudeHookHelperPath(dir));
    expect(readFileSync(path, 'utf8')).toBe(CLAUDE_HOOK_HELPER_SOURCE);
    expect(CLAUDE_HOOK_HELPER_SOURCE).not.toContain(dir);
    writeFileSync(path, 'tampered');
    ensureClaudeHookHelper(dir);
    expect(readFileSync(path, 'utf8')).toBe(CLAUDE_HOOK_HELPER_SOURCE);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('quotes a Windows-style path with double quotes and POSIX paths with single quotes', () => {
    expect(buildClaudeHookCommand('C:\\Program Files\\node.exe', 'C:\\data dir\\hooks\\session-end.cjs', 'C:\\data dir\\runs\\r.json', 'win32'))
      .toBe('"C:\\Program Files\\node.exe" "C:\\data dir\\hooks\\session-end.cjs" "C:\\data dir\\runs\\r.json"');
    expect(buildClaudeHookCommand("/o'b/node", '/d/h.cjs', '/d/m.json', 'linux')).toBe("'/o'\\''b/node' '/d/h.cjs' '/d/m.json'");
  });

  it('rejects paths with quote or dollar characters', () => {
    expect(buildClaudeHookCommand('/n', '/d"x/h.cjs', '/m', 'linux')).toBeUndefined();
    expect(buildClaudeHookCommand('/n', '/h', '/$HOME/m', 'win32')).toBeUndefined();
  });

  it('omits --settings when the data dir is unsafe', () => {
    const dir = join(tmp(), 'bad$dir');
    const inv = new ClaudeAdapter().buildInvocation('p', { ...opts, dataDir: dir });
    expect(inv.args).not.toContain('--settings');
  });

  it('omits --settings when the helper cannot be written, and the invocation is otherwise complete', () => {
    const dir = tmp();
    // A file where the hooks directory must go makes the helper unwritable.
    writeFileSync(join(dir, 'hooks'), 'not a dir');
    const inv = new ClaudeAdapter().buildInvocation('p', { ...opts, dataDir: dir });
    expect(inv.args).not.toContain('--settings');
    expect(inv.args).toContain('stream-json');
  });

  it('redacts only the --settings value for stored and displayed commands', () => {
    const args = ['-p', '--settings', '{"hooks":{}}', '--verbose'];
    expect(redactSettingsArg(args)).toEqual(['-p', '--settings', '<session-end-hook>', '--verbose']);
    expect(redactSettingsArg(['x'])).toEqual(['x']);
  });
});

it('resolves Claude transcripts with slash and dot cwd encoding', () => {
  expect(resolveTranscriptPath('/root/projects/crontick/.worktrees/claude-engine', 'session-1', { env: {}, homedir: () => '/home/tester' }))
    .toBe('/home/tester/.claude/projects/-root-projects-crontick--worktrees-claude-engine/session-1.jsonl');
});

it('resolves Claude transcripts under CLAUDE_CONFIG_DIR when set, ignoring the home directory', () => {
  expect(resolveTranscriptPath('/work/my.proj', 'sid-1', { env: { CLAUDE_CONFIG_DIR: '/custom/cfg' }, homedir: () => '/home/tester' }))
    .toBe('/custom/cfg/projects/-work-my-proj/sid-1.jsonl');
});

it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or empty', () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }]) {
    expect(resolveTranscriptPath('/work/p', 'sid-1', { env, homedir: () => '/home/tester' }))
      .toBe('/home/tester/.claude/projects/-work-p/sid-1.jsonl');
  }
});

it('adapter.resumeTranscriptPath honors the supplied environment', () => {
  expect(new ClaudeAdapter().resumeTranscriptPath('/work/p', 'sid-1', { CLAUDE_CONFIG_DIR: '/custom/cfg' }))
    .toBe('/custom/cfg/projects/-work-p/sid-1.jsonl');
});

it('resolves Windows Claude transcripts using the drive and separators', () => {
  const result = resolveTranscriptPath('C:\\Users\\tester\\my.project', 'session-1', { env: {}, homedir: () => '/home/tester' });
  expect(result.replaceAll('\\', '/')).toBe('/home/tester/.claude/projects/C--Users-tester-my-project/session-1.jsonl');
});

describe('Claude stream-json result parsing', () => {
  const adapter = new ClaudeAdapter();

  it('uses the last well-formed result line and extracts usage metadata', () => {
    const older = JSON.stringify({ type: 'result', session_id: 'older', is_error: true, result: 'old failure' });
    const newest = JSON.stringify({
      type: 'result', session_id: 'latest', is_error: false, subtype: 'success',
      total_cost_usd: 0.25, num_turns: 3, usage: { input_tokens: 20, output_tokens: 7 }, result: 'done',
    });
    expect(adapter.parseResult(0, `${older}\n{"type":"assistant"}\n${newest}\n{"type":"result"`, '')).toEqual({
      status: 'success', exitCode: 0, sessionId: 'latest', costUsd: 0.25,
      turns: 3, usage: { input_tokens: 20, output_tokens: 7 }, engineStatus: 'success',
    });
  });

  it('uses the result message, then subtype, for a Claude error at exit code zero', () => {
    const line = JSON.stringify({ type: 'result', session_id: 'failed-id', is_error: true, subtype: 'error_during_execution', result: 'tool failed' });
    expect(adapter.parseResult(0, `${line}\n`, '')).toMatchObject({
      status: 'failed', exitCode: 0, sessionId: 'failed-id', error: 'tool failed', engineStatus: 'error_during_execution',
    });
    const withoutMessage = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns', result: '' });
    expect(adapter.parseResult(0, `${withoutMessage}\n`, '').error).toBe('error_max_turns');
  });

  it('falls back to the exit-code table when the result is absent or truncated', () => {
    const tail = '{"type":"assistant"}\n{"type":"result","is_error":true';
    expect(adapter.parseResult(0, tail, '')).toEqual({ status: 'success', exitCode: 0 });
    expect(adapter.parseResult(9, tail, '')).toEqual({ status: 'failed', exitCode: 9 });
    expect(adapter.parseResult(null, tail, '')).toEqual({ status: 'failed', error: 'process exited without code' });
  });
});

describe('Claude resume safety', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup(options: Parameters<typeof fakeClaudeEngineConfig>[0] = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-resume-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEngine: 'test-claude', engines: { 'test-claude': fakeClaudeEngineConfig(options) } }));
    mkdirSync(join(dir, 'jobs'));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    const job: Job = {
      id: 'resume-job', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: false, sessionId: 'session-1', cwd: dir },
      overlap: 'skip', retry: { max: 2, backoffSec: 0 },
    };
    store.upsertJob(job);
    const run = store.insertRun(job.id);
    return { dir, store, job, run, cleanup: () => {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    } };
  }

  async function seedEligible(fixture: Awaited<ReturnType<typeof setup>>) {
    const freshJob: Job = { ...fixture.job, action: { ...fixture.job.action, sessionId: undefined } };
    fixture.store.upsertJob(freshJob);
    const priorRun = fixture.store.insertRun(freshJob.id);
    await new Runner(nodeSpawn).run(freshJob, priorRun.id, fixture.store);
    const sessionId = fixture.store.getRun(priorRun.id)?.sessionId;
    expect(sessionId).toMatch(uuidPattern);
    const resumeJob: Job = { ...fixture.job, action: { ...fixture.job.action, sessionId } };
    fixture.store.upsertJob(resumeJob);
    return { resumeJob, sessionId };
  }

  it('fails before spawn when the resume transcript is missing, without retrying', async () => {
    const fixture = await setup();
    try {
      const { resumeJob, sessionId } = await seedEligible(fixture);
      const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
      const transcriptExists = vi.fn(() => false);
      await new Runner(spawnSpy as unknown as typeof nodeSpawn, undefined, undefined, undefined, undefined, transcriptExists).run(resumeJob, fixture.run.id, fixture.store);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(transcriptExists).toHaveBeenCalledWith(resolveTranscriptPath(fixture.dir, sessionId!));
      expect(transcriptExists).toHaveBeenCalledTimes(1);
      expect(fixture.store.getRun(fixture.run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('SESSION_NOT_FOUND') });
    } finally { fixture.cleanup(); }
  });

  it('rejects an explicit ID even when its transcript exists if no completed run captured it', async () => {
    const fixture = await setup();
    try {
      const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
      const transcriptExists = vi.fn(() => true);
      await new Runner(spawnSpy as unknown as typeof nodeSpawn, undefined, undefined, undefined, undefined, transcriptExists).run(fixture.job, fixture.run.id, fixture.store);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(fixture.store.getRun(fixture.run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('SESSION_NOT_FOUND') });
    } finally { fixture.cleanup(); }
  });

  it('spawns with ignored stdin when the resume transcript exists', async () => {
    const fixture = await setup();
    try {
      const { resumeJob } = await seedEligible(fixture);
      const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
      await new Runner(spawnSpy as unknown as typeof nodeSpawn, undefined, undefined, undefined, undefined, () => true).run(resumeJob, fixture.run.id, fixture.store);
      expect(spawnSpy).toHaveBeenCalledOnce();
      expect(spawnSpy.mock.calls[0]?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
      expect(fixture.store.getRun(fixture.run.id)?.status).toBe('success');
      const stored = fixture.store.getRun(fixture.run.id)?.command ?? '';
      expect(stored).toContain('--settings <session-end-hook>');
      expect(stored).not.toMatch(/hooks|SessionEnd|base64|eval\(/);
    } finally { fixture.cleanup(); }
  });

  // Hardening: JobSchema's sessionId has no format restriction (kept broad
  // deliberately, see claude-transcript.ts). Defense in depth against a
  // sessionId crafted to escape the intended transcript directory.
  it('never lets a path-traversal sessionId escape the transcript directory', () => {
    for (const evil of ['../../etc/passwd', '..\\..\\evil', 'a/../../b', 'nul\0byte', '/etc/passwd', '\\\\host\\share']) {
      expect(isUnsafeSessionId(evil)).toBe(true);
    }
    expect(isUnsafeSessionId('94697a61-f71d-450b-87bb-a82463a2a6b1')).toBe(false);

    const cwd = '/some/project';
    const homeDir = '/home/tester';
    const path = resolveTranscriptPath(cwd, '../../../etc/passwd', { env: {}, homedir: () => homeDir });
    expect(path.startsWith(join(homeDir, '.claude', 'projects'))).toBe(true);
    expect(path).not.toContain('..');
    expect(path).not.toContain('etc');
  });

  it('fails closed before spawn for a path-traversal sessionId, even when marked completed', async () => {
    const fixture = await setup();
    try {
      const evilId = '../../etc/passwd';
      const evilJob: Job = { ...fixture.job, action: { ...fixture.job.action, sessionId: evilId } };
      fixture.store.upsertJob(evilJob);
      // Simulate a (hypothetically forged or corrupted) row that claims
      // completion for this id -- the path check must still fail closed.
      fixture.store.markCompletedClaudeSession(fixture.run.id, evilId);
      const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
      // Deliberately uses the REAL transcriptFileExists (no stub) to prove no
      // traversal-crafted path is ever handed to the filesystem as "found".
      await new Runner(spawnSpy as unknown as typeof nodeSpawn).run(evilJob, fixture.run.id, fixture.store);
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(fixture.store.getRun(fixture.run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('SESSION_NOT_FOUND') });
    } finally { fixture.cleanup(); }
  });
});

describe('Claude run session assignment', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists the assigned ID after spawn and before the fake Claude emits output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    const fake = fakeClaudeEngineConfig({ delayMs: 25 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEngine: 'test-claude', engines: { 'test-claude': fake } }));
    mkdirSync(join(dir, 'jobs'));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    try {
      const job: Job = {
        id: 'job-1', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: false },
        overlap: 'skip', retry: { max: 0, backoffSec: 30 },
      };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      let sessionAtFirstOutput: string | undefined;
      let spawnedArgs: readonly string[] = [];
      const spawnFn: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        spawnedArgs = args;
        const child = nodeSpawn(command, args, opts);
        child.stdout?.once('data', () => { sessionAtFirstOutput = store.getRun(run.id)?.sessionId; });
        return child;
      }) as typeof nodeSpawn;
      await new Runner(spawnFn).run(job, run.id, store);
      const persisted = store.getRun(run.id);
      expect(sessionAtFirstOutput).toMatch(uuidPattern);
      expect(persisted?.sessionId).toBe(sessionAtFirstOutput);
      expect(persisted?.status).toBe('success');
      expect(spawnedArgs.slice(fake.args.length, -1)).toEqual([
        '-p', 'hello', '--output-format', 'stream-json', '--verbose',
        '--session-id', sessionAtFirstOutput, '--settings',
      ]);
      expect(JSON.parse(spawnedArgs.at(-1)!)).toHaveProperty('hooks.SessionEnd');

      const resumeRun = store.insertRun(job.id);
      const resumeJob: Job = { ...job, action: { ...job.action, sessionId: persisted?.sessionId } };
      let resumeArgs: readonly string[] = [];
      const resumeSpawnFn: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        resumeArgs = args;
        return nodeSpawn(command, args, opts);
      }) as typeof nodeSpawn;
      await new Runner(resumeSpawnFn, undefined, undefined, undefined, undefined, () => true).run(resumeJob, resumeRun.id, store);
      expect(resumeArgs.slice(fake.args.length, -1)).toEqual([
        '-p', 'hello', '--output-format', 'stream-json', '--verbose',
        '--resume', persisted?.sessionId, '--settings',
      ]);
      expect(JSON.parse(resumeArgs.at(-1)!)).toHaveProperty('hooks.SessionEnd');
      expect(store.getRun(resumeRun.id)?.sessionId).toBe(persisted?.sessionId);
    } finally {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });

  it('records a failed run when fake Claude exits zero with is_error true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-error-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    const fake = fakeClaudeEngineConfig({ isError: true, result: 'tool failed' });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEngine: 'test-claude', engines: { 'test-claude': fake } }));
    mkdirSync(join(dir, 'jobs'));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    try {
      const job: Job = {
        id: 'job-error', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: false },
        overlap: 'skip', retry: { max: 0, backoffSec: 30 },
      };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      const markerPath = join(dir, 'runs', `${run.id}.claude-hook.json`);
      const spawnWithMarker: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        const child = nodeSpawn(command, args, opts);
        child.once('close', () => {
          mkdirSync(join(dir, 'runs'), { recursive: true });
          writeFileSync(markerPath, JSON.stringify({ exitStatus: 0, sessionId: store.getRun(run.id)?.sessionId }));
        });
        return child;
      }) as typeof nodeSpawn;
      await new Runner(spawnWithMarker).run(job, run.id, store);
      expect(store.getRun(run.id)).toMatchObject({ status: 'failed', exitCode: 0, error: 'tool failed' });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });

  it('captures a reusable session only after a result line, including a failed result', async () => {
    for (const [suffix, fakeOptions, expectCapture] of [
      ['missing-result', { omitResult: true }, false],
      ['failed-result', { isError: true }, true],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), `crontick-claude-${suffix}-`));
      dirs.push(dir);
      const priorHome = process.env['CRONTICK_HOME'];
      process.env['CRONTICK_HOME'] = dir;
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEngine: 'test-claude', engines: { 'test-claude': fakeClaudeEngineConfig(fakeOptions) } }));
      mkdirSync(join(dir, 'jobs'));
      const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
      store.open();
      try {
        const job: Job = {
          id: suffix, enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
          action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: true },
          overlap: 'skip', retry: { max: 0, backoffSec: 0 },
        };
        store.upsertJob(job);
        const run = store.insertRun(job.id);
        await new Runner(nodeSpawn).run(job, run.id, store);
        expect(store.getJob(job.id)?.action.sessionId !== undefined).toBe(expectCapture);
        expect(store.getRun(run.id)?.sessionId).toMatch(uuidPattern);
        const priorSessionId = store.getRun(run.id)!.sessionId!;
        const resumeJob: Job = expectCapture
          ? store.getJob(job.id)!
          : { ...job, action: { ...job.action, sessionId: priorSessionId, reuseSession: false } };
        if (!expectCapture) store.upsertJob(resumeJob);
        const resumeRun = store.insertRun(job.id);
        const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
        await new Runner(spawnSpy as unknown as typeof nodeSpawn, undefined, undefined, undefined, undefined, () => true)
          .run(resumeJob, resumeRun.id, store);
        expect(spawnSpy).toHaveBeenCalledTimes(expectCapture ? 1 : 0);
        if (!expectCapture) {
          expect(store.getRun(resumeRun.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('SESSION_NOT_FOUND') });
        }
      } finally {
        store.close();
        if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
        else process.env['CRONTICK_HOME'] = priorHome;
      }
    }
  });

  it('imports Claude history without trusting a forged cross-job completion claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-export-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'test-claude', engines: {
        'test-claude': fakeClaudeEngineConfig(),
        raw: { command: process.execPath, args: [], env: {}, type: 'raw' },
      },
    }));
    mkdirSync(join(dir, 'jobs'));
    mkdirSync(join(dir, 'restored-jobs'));
    const source = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    const restored = new Store(join(dir, 'restored.db'), join(dir, 'restored-jobs'));
    source.open();
    restored.open();
    try {
      const job: Job = {
        id: 'export-job', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: true, cwd: dir },
        overlap: 'skip', retry: { max: 0, backoffSec: 0 },
      };
      source.upsertJob(job);
      const first = source.insertRun(job.id);
      await new Runner(nodeSpawn).run(job, first.id, source);
      const reusableJob = source.getJob(job.id)!;
      const sessionId = reusableJob.action.sessionId!;
      const transcriptPath = resolveTranscriptPath(dir, sessionId);
      mkdirSync(dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, JSON.stringify({ type: 'user', sessionId }) + '\n');
      const exported = source.listRuns({});
      expect(exported).toEqual([expect.objectContaining({ sessionId })]);
      expect(exported[0]?.transcriptPath).toBe(transcriptPath);

      const resetJob = restored.prepareImportedJob(reusableJob);
      expect(resetJob.action).toMatchObject({ reuseSession: true });
      expect(resetJob.action).not.toHaveProperty('sessionId');
      restored.upsertJob(resetJob);
      // Run history is never imported: the restored store has no run that could certify the session.
      expect(restored.listRuns({})).toEqual([]);
      expect(restored.hasCompletedClaudeSession(job.id, sessionId)).toBe(false);
      const next = restored.insertRun(job.id);
      const spawnSpy = vi.fn((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(command, args, opts));
      await new Runner(spawnSpy as unknown as typeof nodeSpawn).run(resetJob, next.id, restored);
      expect(spawnSpy).toHaveBeenCalledOnce();
      expect(restored.getRun(next.id)?.status).toBe('success');
      expect(restored.getRun(next.id)?.sessionId).not.toBe(sessionId);

      const untrusted = new Store(join(dir, 'untrusted.db'), join(dir, 'untrusted-jobs'));
      mkdirSync(join(dir, 'untrusted-jobs'));
      untrusted.open();
      try {
        const otherJob: Job = { ...reusableJob, id: 'other-job' };
        untrusted.upsertJob(otherJob);
        expect(untrusted.hasCompletedClaudeSession(otherJob.id, sessionId)).toBe(false);
        expect(untrusted.prepareImportedJob(otherJob).action).not.toHaveProperty('sessionId');

        const rawJob: Job = { ...reusableJob, id: 'raw-import', action: { ...reusableJob.action, engine: 'raw' } };
        expect(untrusted.prepareImportedJob(rawJob).action).toMatchObject({ engine: 'raw', sessionId });
      } finally { untrusted.close(); }
    } finally {
      source.close();
      restored.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });

  it('sums billable usage across a failed Claude attempt and its successful retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-retry-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'test-claude', engines: { 'test-claude': fakeClaudeEngineConfig() },
    }));
    mkdirSync(join(dir, 'jobs'));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    try {
      const job: Job = {
        id: 'retry-cost-job', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: false, cwd: dir },
        overlap: 'skip', retry: { max: 1, backoffSec: 0 },
      };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      let attempts = 0;
      const spawnWithOutcomes: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        attempts++;
        return nodeSpawn(command, args, {
          ...opts,
          env: {
            ...opts?.env,
            CRONTICK_FAKE_CLAUDE_OPTIONS: JSON.stringify(attempts === 1
              ? { isError: true, usage: { input_tokens: 10, output_tokens: 5, api_key: 'first-secret' } }
              : { usage: { input_tokens: 20, output_tokens: 7, api_key: 'second-secret' } }),
          },
        });
      }) as typeof nodeSpawn;
      await new Runner(spawnWithOutcomes).run(job, run.id, store);
      const recorded = store.getRun(run.id)!;
      expect(attempts).toBe(2);
      expect(recorded).toMatchObject({ status: 'success', costUsd: 0.02, turns: 2 });
      expect(JSON.parse(recorded.usageJson!)).toEqual({ input_tokens: 30, output_tokens: 12, api_key: '[REDACTED]' });
    } finally {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });

  // Regression for: hasCompletedClaudeSession() used to also require
  // status IN ('success','failed') on the run row that captured the session.
  // A retry reuses the SAME run row across attempts and only reaches a
  // terminal status via finalizeRun() after the whole retry loop ends, so
  // attempt 1's captured, completed session was wrongly rejected by attempt
  // 2's resume preflight (row still 'running') -- aborting the retry after
  // one attempt instead of resuming into the session attempt 1 captured.
  it('resumes across a retry within the same run when reuseSession captures a session mid-loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-claude-reuse-retry-'));
    dirs.push(dir);
    const priorHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'test-claude', engines: { 'test-claude': fakeClaudeEngineConfig() },
    }));
    mkdirSync(join(dir, 'jobs'));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    try {
      const job: Job = {
        id: 'reuse-retry-job', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: true, cwd: dir },
        overlap: 'skip', retry: { max: 1, backoffSec: 0 },
      };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      let attempts = 0;
      let firstSessionId: string | undefined;
      const spawnWithRetry: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        attempts++;
        const argv = args as string[];
        const flagValue = (name: string) => argv[argv.indexOf(name) + 1];
        if (attempts === 1) {
          firstSessionId = flagValue('--session-id');
          expect(firstSessionId).toMatch(uuidPattern);
          // Simulate Claude having written its own transcript for this
          // session for real, before attempt 2's resume preflight checks for
          // it -- exercising the actual (non-stubbed) transcriptFileExists.
          const transcriptPath = resolveTranscriptPath(dir, firstSessionId!);
          mkdirSync(dirname(transcriptPath), { recursive: true });
          writeFileSync(transcriptPath, JSON.stringify({ type: 'user', sessionId: firstSessionId }) + '\n');
          return nodeSpawn(command, args, {
            ...opts,
            env: { ...opts?.env, CRONTICK_FAKE_CLAUDE_OPTIONS: JSON.stringify({ isError: true }) },
          });
        }
        // Attempt 2 must resume the exact session id captured from attempt 1's result line.
        expect(argv).toContain('--resume');
        expect(flagValue('--resume')).toBe(firstSessionId);
        expect(argv).not.toContain('--session-id');
        return nodeSpawn(command, args, opts);
      }) as typeof nodeSpawn;
      await new Runner(spawnWithRetry).run(job, run.id, store);
      expect(attempts).toBe(2);
      const recorded = store.getRun(run.id)!;
      expect(recorded.status).toBe('success');
      expect(recorded.sessionId).toBe(firstSessionId);
    } finally {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });
});
