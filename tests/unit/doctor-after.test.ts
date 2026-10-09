/**
 * doctor reports after-trigger jobs with a dangling or cyclic upstream (inert; hand-edited job files).
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctorChecks } from '../../src/doctor.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

function job(id: string, schedule: unknown, alias: string): Record<string, unknown> {
  return { id, alias, enabled: true, schedule, action: { kind: 'prompt', prompt: 'p' } };
}

async function doctorAgainst(jobs: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-doctor-after-'));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/jobs' ? JSON.stringify(jobs) : '{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const daemonUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await runDoctorChecks({ env: { CRONTICK_HOME: dir }, daemonUrl, checkMcpHelp: false });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('doctor after-trigger check', () => {
  it('flags dangling and cyclic after-jobs as failing', async () => {
    const result = await doctorAgainst([
      job(A, { kind: 'after', jobId: MISSING, status: 'any' }, 'dangling'),
      job(B, { kind: 'after', jobId: B, status: 'any' }, 'selfcycle'),
    ]);
    const check = result.checks.find((c) => c.name === 'after-trigger jobs');
    expect(check?.ok).toBe(false);
    expect(check?.note).toContain('dangling: upstream missing');
    expect(check?.note).toContain('selfcycle: upstream cycle');
  });

  it('adds no check when all after-jobs are healthy', async () => {
    const result = await doctorAgainst([
      job(A, { kind: 'cron', cron: '* * * * *' }, 'up'),
      job(B, { kind: 'after', jobId: A, status: 'any' }, 'down'),
    ]);
    expect(result.checks.find((c) => c.name === 'after-trigger jobs')).toBeUndefined();
  });
});
