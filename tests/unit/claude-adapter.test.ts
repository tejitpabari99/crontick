import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { ClaudeAdapter } from '../../src/engines/claude-adapter.js';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { fakeClaudeEngineConfig } from '../helpers/fake-claude.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Claude invocation', () => {
  const adapter = new ClaudeAdapter();
  const options = {
    command: 'claude', engineArgs: [], runId: 'run-1', jobId: 'job-1', dataDir: '/tmp/crontick',
    reuseSession: false, args: ['--max-budget-usd', '1'], env: { SAMPLE: 'yes' },
  };

  it('assigns a UUID and builds stream-json argv for a fresh run', () => {
    const invocation = adapter.buildInvocation('do work', options);
    expect(invocation.sessionId).toMatch(uuidPattern);
    expect(invocation).toMatchObject({ command: 'claude', env: { SAMPLE: 'yes' } });
    expect(invocation.args).toEqual([
      '-p', 'do work', '--output-format', 'stream-json', '--verbose',
      '--session-id', invocation.sessionId, '--max-budget-usd', '1', '--settings', '{}',
    ]);
  });

  it('resumes the given session without assigning another ID', () => {
    const sessionId = '94697a61-f71d-450b-87bb-a82463a2a6b1';
    const invocation = adapter.buildInvocation('continue', { ...options, sessionId });
    expect(invocation.sessionId).toBe(sessionId);
    expect(invocation.args).toEqual([
      '-p', 'continue', '--output-format', 'stream-json', '--verbose',
      '--resume', sessionId, '--max-budget-usd', '1', '--settings', '{}',
    ]);
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
      expect(spawnedArgs.slice(fake.args.length)).toEqual([
        '-p', 'hello', '--output-format', 'stream-json', '--verbose',
        '--session-id', sessionAtFirstOutput, '--settings', '{}',
      ]);

      const resumeRun = store.insertRun(job.id);
      const resumeJob: Job = { ...job, action: { ...job.action, sessionId: persisted?.sessionId } };
      let resumeArgs: readonly string[] = [];
      const resumeSpawnFn: typeof nodeSpawn = ((command: string, args: readonly string[], opts: Parameters<typeof nodeSpawn>[2]) => {
        resumeArgs = args;
        return nodeSpawn(command, args, opts);
      }) as typeof nodeSpawn;
      await new Runner(resumeSpawnFn).run(resumeJob, resumeRun.id, store);
      expect(resumeArgs.slice(fake.args.length)).toEqual([
        '-p', 'hello', '--output-format', 'stream-json', '--verbose',
        '--resume', persisted?.sessionId, '--settings', '{}',
      ]);
      expect(store.getRun(resumeRun.id)?.sessionId).toBe(persisted?.sessionId);
    } finally {
      store.close();
      if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = priorHome;
    }
  });
});
