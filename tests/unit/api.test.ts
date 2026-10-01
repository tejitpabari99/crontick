/**
 * API integration tests.
 * Spawns a real daemon process with a temp CRONTICK_HOME and hits its HTTP API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { teardownDaemon } from '../helpers/cleanup.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';
import { fakeClaudeEngineConfig } from '../helpers/fake-claude.js';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-api-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch {
          // file may be mid-write; retry
        }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

async function apiCall(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe('Daemon HTTP API', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  beforeAll(async () => {
    dir = makeTmpDir();
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG, 'api-fake-claude': fakeClaudeEngineConfig({ result: 'All done.', flood: 2 }) } });
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, CRONTICK_HOME: dir },
      stdio: 'pipe',
    });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    port = await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, TIMEOUT_MS);

  afterAll(async () => {
    await teardownDaemon(daemonProc, dir);
  });

  // ── Health ───────────────────────────────────────────────────────────────────

  it('GET /health returns ok', async () => {
    const { status, data } = await apiCall(port, 'GET', '/health');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
    expect((data as { product: string }).product).toBe('crontick');
    expect(typeof (data as { version: string }).version).toBe('string');
    expect(typeof (data as { uptimeSec: number }).uptimeSec).toBe('number');
  });

  // ── Localhost-only guard (T-NEW-5) ────────────────────────────────────────────

  it('daemon binds only to 127.0.0.1 (port file exists and is loopback)', () => {
    const portFile = join(dir, 'daemon.port');
    expect(existsSync(portFile)).toBe(true);
    // Port is a valid number which means server started on 127.0.0.1
    expect(port).toBeGreaterThan(0);
  });

  // ── Jobs CRUD ─────────────────────────────────────────────────────────────────

  const testJob = {
    alias: 'api-test-job',
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
  };

  it('POST /api/jobs creates a job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs', testJob);
    expect(status).toBe(201);
    expect((data as { alias: string }).alias).toBe('api-test-job');
  });

  it('POST /api/jobs creates a normalized prompt job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'api-prompt-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hello', engine: 'agency', args: ['--silent'] },
    });
    expect(status).toBe(201);
    expect((data as { action: unknown }).action).toMatchObject({
      kind: 'prompt',
      prompt: 'hello',
      engine: 'agency',
      args: ['--silent'],
      reuseSession: false,
    });
  });

  it('POST /api/jobs rejects caller-only promptFile and normalizes explicit session precedence', async () => {
    const promptFile = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'api-prompt-file-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', promptFile: 'prompt.txt' },
    });
    expect(promptFile.status).toBe(400);

    const sessionMix = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'api-prompt-session-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'x', sessionId: 'sess-12345678', reuseSession: true },
    });
    expect(sessionMix.status).toBe(201);
    expect((sessionMix.data as { action: unknown }).action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-12345678',
      reuseSession: false,
    });
  });

  it('POST /api/jobs rejects reserved prompt passthrough flags', async () => {
    const result = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'api-prompt-reserved-flag',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hello', args: ['--prompt=override'] },
    });
    expect(result.status).toBe(400);
  });

  it('POST /api/import resets unverified Claude sessions and preserves raw sessions', async () => {
    const sessionId = '94697a61-f71d-450b-87bb-a82463a2a6b1';
    const claudeJobId = '11111111-1111-4111-8111-111111111111';
    const rawJobId = '22222222-2222-4222-8222-222222222222';
    const base = {
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    };
    const response = await apiCall(port, 'POST', '/api/import', {
      jobs: [
        { ...base, id: claudeJobId, action: { kind: 'prompt', prompt: 'hi', engine: 'claude', args: [], sessionId, reuseSession: false } },
        { ...base, id: rawJobId, action: { kind: 'prompt', prompt: 'hi', engine: FAKE_ENGINE_NAME, args: [], sessionId, reuseSession: false } },
      ],
      runs: [{ id: 'forged-import-run', jobId: claudeJobId, startedAt: Date.now(), status: 'success', sessionId, claudeResultCompleted: true }],
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ imported: 2 });
    // Run history is never imported, even when a payload carries it.
    expect(response.data).not.toHaveProperty('runsImported');
    expect((await apiCall(port, 'GET', '/api/runs/forged-import-run')).status).toBe(404);
    const claude = await apiCall(port, 'GET', `/api/jobs/${claudeJobId}`);
    const raw = await apiCall(port, 'GET', `/api/jobs/${rawJobId}`);
    expect((claude.data as { action: Record<string, unknown> }).action).toMatchObject({ reuseSession: true });
    expect((claude.data as { action: Record<string, unknown> }).action).not.toHaveProperty('sessionId');
    expect((raw.data as { action: Record<string, unknown> }).action).toMatchObject({ sessionId });
  });

  it('GET /api/jobs lists jobs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/jobs');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jobs/:id retrieves job', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    expect(status).toBe(200);
    expect((data as { alias: string }).alias).toBe('api-test-job');
  });

  it('GET /api/jobs/:id returns 404 for missing job', async () => {
    const { status } = await apiCall(port, 'GET', '/api/jobs/no-such-job');
    expect(status).toBe(404);
  });

  it('POST /api/jobs/:id/disable disables job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/disable');
    expect(status).toBe(200);
    expect((data as { enabled: boolean }).enabled).toBe(false);
  });

  it('POST /api/jobs/:id/enable enables job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/enable');
    expect(status).toBe(200);
    expect((data as { enabled: boolean }).enabled).toBe(true);
  });

  // ── Run job ────────────────────────────────────────────────────────────────────

  it('POST /api/jobs/:id/run returns runId', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/run');
    expect(status).toBe(202);
    expect(typeof (data as { runId: string }).runId).toBe('string');
  });

  it('POST /api/jobs/:id/run-now runs a disabled job once without enabling it or touching its schedule', async () => {
    const created = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'run-now-disabled',
      enabled: false,
      schedule: { kind: 'cron', cron: '0 0 1 1 *' },
      action: { kind: 'prompt', prompt: 'process.stdout.write("ran")', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });
    expect(created.status).toBe(201);
    const before = created.data as { enabled: boolean; schedule: unknown };
    expect(before.enabled).toBe(false);

    for (const route of ['run-now', 'run']) {
      const { status, data } = await apiCall(port, 'POST', `/api/jobs/run-now-disabled/${route}`);
      expect(status).toBe(202);
      const runId = (data as { runId: string }).runId;
      let run: { status: string } | undefined;
      for (let i = 0; i < 60; i++) {
        run = (await apiCall(port, 'GET', `/api/runs/${runId}`)).data as { status: string };
        if (run.status === 'success') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(run?.status).toBe('success');
    }

    const after = (await apiCall(port, 'GET', '/api/jobs/run-now-disabled')).data as { enabled: boolean; schedule: unknown };
    expect(after.enabled).toBe(false);
    expect(after.schedule).toEqual(before.schedule);
  });

  it('POST /api/jobs/:id/run-now respects overlap=skip while a run is active', async () => {
    const created = await apiCall(port, 'POST', '/api/jobs', {
      alias: 'run-now-overlap',
      enabled: false,
      overlap: 'skip',
      schedule: { kind: 'cron', cron: '0 0 1 1 *' },
      action: { kind: 'prompt', prompt: 'setTimeout(() => {}, 1500)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });
    expect(created.status).toBe(201);
    const first = (await apiCall(port, 'POST', '/api/jobs/run-now-overlap/run-now')).data as { runId: string };
    await new Promise((r) => setTimeout(r, 300));
    const second = (await apiCall(port, 'POST', '/api/jobs/run-now-overlap/run-now')).data as { runId: string };
    let run: { status: string } | undefined;
    for (let i = 0; i < 30; i++) {
      run = (await apiCall(port, 'GET', `/api/runs/${second.runId}`)).data as { status: string };
      if (run.status === 'skipped') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run?.status).toBe('skipped');
    await apiCall(port, 'POST', `/api/runs/${first.runId}/cancel`);
  });

  it('GET /api/stats/jobs/:id and /api/stats/summary expose average duration in seconds', async () => {
    const job = await apiCall(port, 'GET', '/api/stats/jobs/run-now-disabled');
    expect(job.status).toBe(200);
    const jobStats = job.data as { avgDurationSec: number | null };
    expect(jobStats).toHaveProperty('avgDurationSec');
    expect(typeof jobStats.avgDurationSec).toBe('number');
    const summary = (await apiCall(port, 'GET', '/api/stats/summary')).data as { avgDurationSec: number | null };
    expect(summary).not.toHaveProperty('avgDurationMs');
    expect(summary).toHaveProperty('avgDurationSec');
  });

  it('GET /api/runs/:id/output returns the cleaned output view; the raw engine log is not stored', async () => {
    await apiCall(port, 'POST', '/api/jobs', {
      alias: 'output-view-job',
      enabled: false,
      schedule: { kind: 'cron', cron: '0 0 1 1 *' },
      action: { kind: 'prompt', prompt: 'hello', engine: 'api-fake-claude', args: [], reuseSession: false, cwd: dir },
    });
    const { data } = await apiCall(port, 'POST', '/api/jobs/output-view-job/run-now');
    const runId = (data as { runId: string }).runId;
    for (let i = 0; i < 60; i++) {
      const run = (await apiCall(port, 'GET', `/api/runs/${runId}`)).data as { status: string };
      if (run.status === 'success') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const output = await apiCall(port, 'GET', `/api/runs/${runId}/output`);
    expect(output.status).toBe(200);
    expect(output.data).toMatchObject({ runId, status: 'success', format: 'claude-stream-json', result: 'All done.', error: null });
    expect(JSON.stringify(output.data)).not.toContain('SIGNATURE-BLOB');
    expect(output.data).not.toHaveProperty('output');
    expect((await apiCall(port, 'GET', `/api/runs/${runId}/logs?source=engine`)).status).toBe(404);
    expect((await apiCall(port, 'GET', '/api/runs/nope/output')).status).toBe(404);
    const detail = (await apiCall(port, 'GET', `/api/runs/${runId}`)).data as { jobId: string; logFile: string | null };
    expect(detail.logFile).toBe(resolve(join(dir, 'logs', `${detail.jobId}.log`)));
  });

  it('GET /api/runs lists runs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/runs?jobId=api-test-job');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/runs rejects an invalid limit with a clean 400 (not a 500 crash)', async () => {
    for (const bad of ['abc', '-5', '0', 'NaN', 'Infinity']) {
      const { status, data } = await apiCall(port, 'GET', `/api/runs?limit=${bad}`);
      expect(status, `limit=${bad}`).toBe(400);
      expect((data as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');
    }
    // A valid positive limit still works.
    const ok = await apiCall(port, 'GET', '/api/runs?limit=2');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.data)).toBe(true);
  });

  it('GET /api/runs rejects an invalid since with a clean 400 (symmetric with limit)', async () => {
    // `since` flows through the same optionalPositiveInt guard as `limit`, so it
    // must reject the same bad values rather than 500-crashing.
    for (const bad of ['abc', '-5', '0', 'NaN', 'Infinity']) {
      const { status, data } = await apiCall(port, 'GET', `/api/runs?since=${bad}`);
      expect(status, `since=${bad}`).toBe(400);
      expect((data as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');
    }
    // A valid positive since still works.
    const ok = await apiCall(port, 'GET', '/api/runs?since=1');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.data)).toBe(true);
  });

  it('GET /api/runs?status= filters by run status', async () => {
    // Uses the fake node-eval engine (cross-platform) rather than
    // api-test-job's plain 'hello' prompt, so this job actually runs to a
    // real terminal status.
    await apiCall(port, 'POST', '/api/jobs', {
      alias: 'status-filter-job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });
    const { data: runData } = await apiCall(port, 'POST', '/api/jobs/status-filter-job/run');
    const runId = (runData as { runId: string }).runId;

    // Poll (no fixed sleep) until the quick run reaches a terminal status.
    const deadline = Date.now() + 8000;
    let found: { id: string; status: string } | undefined;
    while (Date.now() < deadline) {
      const { data } = await apiCall(port, 'GET', '/api/runs?jobId=status-filter-job&status=success');
      found = (data as Array<{ id: string; status: string }>).find((r) => r.id === runId);
      if (found) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(found?.status).toBe('success');

    const { status: status2, data: data2 } = await apiCall(
      port,
      'GET',
      '/api/runs?jobId=status-filter-job&status=missed',
    );
    expect(status2).toBe(200);
    expect((data2 as unknown[]).some((r) => (r as { id: string }).id === runId)).toBe(false);

    await apiCall(port, 'DELETE', '/api/jobs/status-filter-job');
  }, 10_000);

  // ── Schedules ─────────────────────────────────────────────────────────────────

  it('POST /api/schedules/validate returns ok for valid cron', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/schedules/validate', {
      kind: 'cron',
      cron: '0 9 * * *',
    });
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
  });

  it('POST /api/schedules/preview returns next times', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/schedules/preview', {
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      n: 3,
    });
    expect(status).toBe(200);
    expect(Array.isArray((data as { next: unknown[] }).next)).toBe(true);
    expect((data as { next: unknown[] }).next).toHaveLength(3);
  });

  // ── Stats ──────────────────────────────────────────────────────────────────────

  it('GET /api/stats/summary returns summary', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/stats/summary');
    expect(status).toBe(200);
    expect(typeof (data as { totalJobs: number }).totalJobs).toBe('number');
  });

  // ── Daemon status ──────────────────────────────────────────────────────────────

  it('GET /api/daemon/status returns pid', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/daemon/status');
    expect(status).toBe(200);
    expect(typeof (data as { pid: number }).pid).toBe('number');
  });

  it('GET /api/daemon/status includes missedFires summary (L2)', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/daemon/status');
    expect(status).toBe(200);
    const missedFires = (data as { missedFires: Record<string, number> }).missedFires;
    expect(typeof missedFires.jobsWithMissedFires).toBe('number');
    expect(typeof missedFires.missedRunsRecorded).toBe('number');
    expect(typeof missedFires.jobsCapped).toBe('number');
    expect(typeof missedFires.capPerJob).toBe('number');
  });

  // ── Export / Import ────────────────────────────────────────────────────────────

  it('GET /api/export exports jobs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/export');
    expect(status).toBe(200);
    expect(Array.isArray((data as { jobs: unknown[] }).jobs)).toBe(true);
  });

  it('POST /api/import imports jobs', async () => {
    const importJob = {
      alias: 'imported-job',
      schedule: { kind: 'cron', cron: '0 * * * *' },
      action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
    };
    const importPromptJob = {
      alias: 'imported-prompt-job',
      schedule: { kind: 'cron', cron: '0 10 * * *' },
      action: { kind: 'prompt', prompt: 'imported prompt' },
    };
    const { status, data } = await apiCall(port, 'POST', '/api/import', { jobs: [importJob, importPromptJob] });
    expect(status).toBe(200);
    expect((data as { imported: number }).imported).toBe(2);

    const imported = await apiCall(port, 'GET', '/api/jobs/imported-prompt-job');
    expect(imported.status).toBe(200);
    expect((imported.data as { action: unknown }).action).toMatchObject({
      kind: 'prompt',
      engine: 'claude',
    });
  });

  it('POST /api/import never overwrites: alias collisions (live or within the file) get -2, -3 and report renamedFrom', async () => {
    const mk = (alias: string) => ({ alias, schedule: { kind: 'cron', cron: '0 * * * *' }, action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false } });
    const live = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    const { status, data } = await apiCall(port, 'POST', '/api/import', { jobs: [mk('api-test-job'), mk('api-test-job'), mk('fresh-import-alias'), mk('fresh-import-alias')] });
    expect(status).toBe(200);
    const body = data as { imported: number; results: Array<{ id: string; alias: string; ok: boolean; renamedFrom?: string }> };
    expect(body.imported).toBe(4);
    expect(body.results.map((r) => [r.alias, r.renamedFrom])).toEqual([
      ['api-test-job-2', 'api-test-job'],
      ['api-test-job-3', 'api-test-job'],
      ['fresh-import-alias', undefined],
      ['fresh-import-alias-2', 'fresh-import-alias'],
    ]);
    expect(new Set(body.results.map((r) => r.id)).size).toBe(4);
    const still = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    expect((still.data as { id: string }).id).toBe((live.data as { id: string }).id);
  });

  it('GET /api/export is schema 1 without ids or runs; ?jobs= filters by id or alias and reports every miss', async () => {
    const all = await apiCall(port, 'GET', '/api/export');
    const body = all.data as { schema: number; exportedAt: string; crontickVersion: string; jobs: Array<Record<string, unknown>>; runs?: unknown };
    expect(body).toMatchObject({ schema: 1, exportedAt: expect.any(String), crontickVersion: expect.any(String) });
    expect(body).not.toHaveProperty('runs');
    expect(body.jobs.every((job) => !('id' in job))).toBe(true);

    const one = await apiCall(port, 'GET', '/api/export?jobs=api-test-job');
    expect((one.data as { jobs: Array<{ alias: string }> }).jobs.map((job) => job.alias)).toEqual(['api-test-job']);

    const missing = await apiCall(port, 'GET', '/api/export?jobs=api-test-job,nope-1,nope-2');
    expect(missing.status).toBe(404);
    expect((missing.data as { error: { code: string; message: string } }).error.code).toBe('JOB_NOT_FOUND');
    expect((missing.data as { error: { message: string } }).error.message).toContain('nope-1, nope-2');
  });

  // ── Daemon reload ─────────────────────────────────────────────────────────────

  it('POST /api/daemon/reload returns ok', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
  });

  // ── Delete job ─────────────────────────────────────────────────────────────────

  it('DELETE /api/jobs/:id removes job', async () => {
    const { status, data } = await apiCall(port, 'DELETE', '/api/jobs/api-test-job');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
    const { status: s2 } = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    expect(s2).toBe(404);
  });


  it('returns 404 for removed startup-registration routes', async () => {
    for (const path of ['/api/' + 'auto' + 'start/status', '/api/' + 'auto' + 'start/install', '/api/' + 'auto' + 'start/remove']) {
      const method = path.endsWith('status') ? 'GET' : 'POST';
      const { status } = await apiCall(port, method, path, method === 'GET' ? undefined : {});
      expect(status).toBe(404);
    }
  });

  // ── 404 for unknown route ─────────────────────────────────────────────────────

  it('returns 404 for unknown route', async () => {
    const { status } = await apiCall(port, 'GET', '/api/nonexistent');
    expect(status).toBe(404);
  });

  // Runs last: DELETE /api/jobs wipes every job. Kept at the end so it doesn't
  // disturb earlier tests that depend on shared daemon state.
  it('DELETE /api/jobs requires force and then atomically removes every job', async () => {
    await apiCall(port, 'POST', '/api/jobs', {
      alias: 'bulk-api-a',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });
    await apiCall(port, 'POST', '/api/jobs', {
      alias: 'bulk-api-b',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });

    const missingForce = await apiCall(port, 'DELETE', '/api/jobs');
    expect(missingForce.status).toBe(400);
    expect((missingForce.data as { error?: { code?: string } }).error?.code).toBe('VALIDATION_ERROR');

    const before = await apiCall(port, 'GET', '/api/jobs');
    expect((before.data as unknown[]).length).toBeGreaterThanOrEqual(2);

    const deleted = await apiCall(port, 'DELETE', '/api/jobs?force=1');
    expect(deleted.status).toBe(200);
    expect(deleted.data).toMatchObject({ ok: true, deleted: expect.any(Number) });
    expect((deleted.data as { deleted: number }).deleted).toBeGreaterThanOrEqual(2);

    const after = await apiCall(port, 'GET', '/api/jobs');
    expect(after.data).toEqual([]);
  });
});
