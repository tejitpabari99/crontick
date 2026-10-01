import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { fakeClaudeEngineConfig } from '../helpers/fake-claude.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('run usage fields', () => {
  it('persists Claude usage and redacts secrets, while raw runs omit engine metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-run-usage-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'jobs'));
    const oldHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'test-claude',
      engines: {
        'test-claude': fakeClaudeEngineConfig({ usage: { input_tokens: 10, output_tokens: 5, api_key: 'top-secret' } }),
        'test-raw': { command: process.execPath, args: ['-e'], type: 'raw' },
      },
    }));
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    try {
      const job = (id: string, engine: string, prompt: string): Job => ({
        id, enabled: true, schedule: { kind: 'cron', cron: '* * * * *' },
        action: { kind: 'prompt', engine, prompt, args: [], reuseSession: false, cwd: dir },
        overlap: 'skip', retry: { max: 0, backoffSec: 0 },
      });
      const claude = job('claude-job', 'test-claude', 'hello');
      store.upsertJob(claude);
      const claudeRun = store.insertRun(claude.id);
      await new Runner(spawn).run(claude, claudeRun.id, store);
      const record = store.getRun(claudeRun.id)!;
      expect(record).toMatchObject({
        status: 'success', costUsd: 0.01, turns: 1, engineStatus: 'success',
        transcriptPath: expect.stringMatching(/\.jsonl$/),
      });
      expect(record.transcriptPath).toContain(record.sessionId);
      expect(JSON.parse(record.usageJson!)).toEqual({ input_tokens: 10, output_tokens: 5, api_key: '[REDACTED]' });

      const raw = job('raw-job', 'test-raw', 'process.exit(0)');
      store.upsertJob(raw);
      const rawRun = store.insertRun(raw.id);
      await new Runner(spawn).run(raw, rawRun.id, store);
      const rawRecord = store.getRun(rawRun.id)!;
      expect(rawRecord.status).toBe('success');
      for (const field of ['costUsd', 'turns', 'usageJson', 'transcriptPath', 'engineStatus']) {
        expect(field in rawRecord).toBe(false);
      }
    } finally {
      store.close();
      if (oldHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = oldHome;
    }
  });
});
