import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import { resolveTranscriptPath } from '../../src/engines/claude-transcript.js';
import type { Job } from '../../src/schemas/job.js';
import { fakeClaudeEngineConfig, type FakeClaudeOptions } from '../helpers/fake-claude.js';

describe('Claude run: stream trimming and transcript path', () => {
  let dir: string;
  let store: Store;
  let priorHome: string | undefined;
  let priorConfigDir: string | undefined;

  function setup(options: FakeClaudeOptions): Job {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEngine: 'test-claude', engines: { 'test-claude': fakeClaudeEngineConfig(options) } }));
    const job: Job = { catchUp: false,
      id: 'stream-job', enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello', engine: 'test-claude', args: [], reuseSession: false, cwd: dir },
      overlap: 'skip', retry: { max: 0, backoffSec: 0 },
    };
    store.upsertJob(job);
    return job;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-stream-'));
    priorHome = process.env['CRONTICK_HOME'];
    priorConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CRONTICK_HOME'] = dir;
    mkdirSync(join(dir, 'jobs'));
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
  });
  afterEach(() => {
    store.close();
    if (priorHome === undefined) delete process.env['CRONTICK_HOME']; else process.env['CRONTICK_HOME'] = priorHome;
    if (priorConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = priorConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists only the final result, usage, cost and turns; interim assistant text is discarded', async () => {
    const job = setup({ flood: 300, result: 'the final answer' });
    const run = store.insertRun(job.id);
    await new Runner(nodeSpawn).run(job, run.id, store);
    const done = store.getRun(run.id)!;
    expect(done).toMatchObject({ status: 'success', costUsd: 0.01, turns: 1 });
    expect(JSON.parse(done.usageJson!)).toEqual({ input_tokens: 10, output_tokens: 5 });
    const out = store.getRunOutput(run.id)!;
    expect(out).toEqual({ format: 'claude-stream-json', result: 'the final answer', engineError: null, stderr: '' });
    expect(JSON.stringify(out)).not.toContain('noise');
  });

  it('stores stderr in full while it is under the stderr cap', async () => {
    const job = setup({ stderrBytes: 300_000 });
    const run = store.insertRun(job.id);
    await new Runner(nodeSpawn).run(job, run.id, store);
    expect(store.getRunOutput(run.id)!.stderr.length).toBeGreaterThan(250_000);
  });

  it('points at the computed transcript path, honoring CLAUDE_CONFIG_DIR, when the hook reports none', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'cfg');
    const job = setup({});
    const run = store.insertRun(job.id);
    await new Runner(nodeSpawn).run(job, run.id, store);
    const done = store.getRun(run.id)!;
    expect(done.transcriptPath).toBe(resolveTranscriptPath(dir, done.sessionId!, { env: { CLAUDE_CONFIG_DIR: join(dir, 'cfg') } }));
    expect(done.transcriptPath!.startsWith(join(dir, 'cfg', 'projects'))).toBe(true);
  });

  it('prefers the transcript path reported by the SessionEnd hook', async () => {
    const reported = join(dir, 'elsewhere', 'reported.jsonl');
    const job = setup({ hookTranscriptPath: reported });
    const run = store.insertRun(job.id);
    await new Runner(nodeSpawn).run(job, run.id, store);
    expect(store.getRun(run.id), JSON.stringify(store.getRunOutput(run.id))).toMatchObject({ status: 'success', transcriptPath: reported });
  });

  it('shows the computed path while the run is still in progress', async () => {
    const job = setup({ delayMs: 400 });
    const run = store.insertRun(job.id);
    const pending = new Runner(nodeSpawn).run(job, run.id, store);
    const deadline = Date.now() + 5000;
    while (store.getRun(run.id)?.transcriptPath === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const running = store.getRun(run.id)!;
    expect(running.status).toBe('running');
    expect(running.transcriptPath).toBe(resolveTranscriptPath(dir, running.sessionId!));
    await pending;
  });
});
