/** `GET /api/runs/:id` reports whether the log file and transcript exist; the raw log route is gone. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

let h: ApiHarness;
let jobId: string;
let runId: string;

beforeAll(async () => {
  h = await startApiHarness('api-run-paths');
  jobId = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'paths-job' }))).data.id as string;
  runId = h.store.insertRun(jobId).id;
});
afterAll(async () => { await h.close(); });

describe('run detail path existence', () => {
  it('flags a missing log file and transcript, then clears the flags once the files exist', async () => {
    const transcript = join(h.dir, 'transcript.jsonl');
    h.store.updateRun(runId, { transcriptPath: transcript });
    const missing = await h.call('GET', `/api/runs/${runId}`);
    expect(missing.data.logFile).toBe(resolve(join(h.dir, 'logs', `${jobId}.log`)));
    expect(missing.data.logFileExists).toBe(false);
    expect(missing.data.transcriptExists).toBe(false);

    mkdirSync(join(h.dir, 'logs'), { recursive: true });
    writeFileSync(join(h.dir, 'logs', `${jobId}.log`), 'x\n');
    writeFileSync(transcript, '{}\n');
    const present = await h.call('GET', `/api/runs/${runId}`);
    expect(present.data.logFileExists).toBe(true);
    expect(present.data.transcriptExists).toBe(true);
  });

  it('no longer serves the log file or stored logs', async () => {
    for (const sub of ['log/raw', 'logs', 'logs/stream']) {
      expect((await fetch(`${h.baseUrl}/api/runs/${runId}/${sub}`)).status).toBe(404);
    }
  });
});
