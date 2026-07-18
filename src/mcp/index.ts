/**
 * crontick MCP server — stdio transport.
 * Thin adapter over the local daemon HTTP API.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, join as pathJoin } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { portFilePath, pidFilePath, logsDir, ensureDirs } from '../paths.js';
import { VERSION } from '../version.js';
import {
  JobSchema,
  ScheduleSchema,
  ActionSchema,
} from '../schemas/job.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Daemon URL resolution ─────────────────────────────────────────────────────

function getDaemonBaseUrl(): string {
  const envUrl = process.env['CRONTICK_DAEMON_URL'];
  if (envUrl) return envUrl.replace(/\/$/, '');
  const pf = portFilePath();
  if (!existsSync(pf)) throw new DaemonUnavailableError('Port file not found.');
  const port = parseInt(readFileSync(pf, 'utf-8').trim(), 10);
  if (isNaN(port) || port <= 0) throw new DaemonUnavailableError('Invalid port in port file.');
  return `http://127.0.0.1:${port}`;
}

class DaemonUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Daemon is not running (${detail}) — run: crontick daemon start`,
    );
    this.name = 'DaemonUnavailableError';
  }
}

function daemonScript(): string {
  return pathResolve(__dirname, '../daemon/index.js');
}

function appendAutostartLog(text: string): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    const logPath = pathJoin(logsDir(), 'daemon.autostart.log');
    let size = 0;
    try { size = statSync(logPath).size; } catch { /* new file */ }
    if (size < 256 * 1024) {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`);
    }
  } catch { /* ignore log errors */ }
}

function waitForPortFile(maxMs = 10_000, getStderr?: () => string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(portFilePath())) {
        // Verify it's a valid port
        try {
          const port = parseInt(readFileSync(portFilePath(), 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve();
        } catch { /* retry */ }
      }
      if (Date.now() - start > maxMs) {
        const stderr = getStderr?.() ?? '';
        const hint = stderr ? `\nAutostart stderr: ${stderr.slice(0, 500)}` : '';
        return reject(new DaemonUnavailableError(`Timed out waiting for daemon to start.${hint}`));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

async function ensureDaemon(): Promise<void> {
  // Check if already running
  try {
    const base = getDaemonBaseUrl();
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return;
  } catch { /* not running or not responding */ }

  if (process.env['CRONTICK_MCP_NO_AUTOSTART'] === '1') {
    throw new DaemonUnavailableError(
      'CRONTICK_MCP_NO_AUTOSTART=1 is set — start the daemon manually: crontick daemon start',
    );
  }

  // Auto-start
  ensureDirs();
  const script = daemonScript();
  if (!existsSync(script)) {
    throw new DaemonUnavailableError(
      `Daemon script not found. Run: npm run build`,
    );
  }
  const stderrChunks: Buffer[] = [];
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderrChunks).length < 4096) stderrChunks.push(chunk);
    });
    // unref so the MCP process can exit even if the daemon stderr pipe stays open
    (child.stderr as NodeJS.ReadableStream & { unref?(): void }).unref?.();
  }
  child.unref();

  const getStderr = (): string => {
    const raw = Buffer.concat(stderrChunks).toString('utf-8');
    return raw.length > 4096 ? raw.slice(0, 4096) + '…' : raw;
  };

  try {
    await waitForPortFile(10_000, getStderr);
  } catch (err) {
    const stderr = getStderr();
    if (stderr) appendAutostartLog(`ensureDaemon failed:\n${stderr}`);
    throw err;
  }
}

// ── API client ────────────────────────────────────────────────────────────────

async function callDaemon(method: string, path: string, body?: unknown): Promise<unknown> {
  const base = getDaemonBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Daemon returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    throw new Error(`[${err?.code ?? 'API_ERROR'}] ${err?.message ?? `HTTP ${res.status}`}`);
  }
  return data;
}

// ── Tool result helpers ───────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function okResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Redact sensitive details before returning errors to the LLM. Exported for testing. */
export function redactForLlm(msg: string): string {
  return msg
    // Loopback address:port
    .replace(/127\.0\.0\.1:\d+/g, '<daemon-addr>')
    // Windows absolute paths: C:\foo\bar  (must have at least one separator)
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    // POSIX absolute paths: only when preceded by start-of-string, whitespace,
    // (, [, or a quote — to avoid matching /path inside http://host/path URLs.
    .replace(/(^|[\s(["'])\/(?:[^\s"'/]+\/)+[^\s"'/]+/g, '$1<path>');
}

function errResult(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const redacted = redactForLlm(msg);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: redacted }, null, 2) }],
    isError: true,
  };
}

async function toolWrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    await ensureDaemon();
    const result = await fn();
    return okResult(result);
  } catch (err) {
    return errResult(err);
  }
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'crontick',
    version: VERSION,
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_job_create',
    {
      description:
        'Create and schedule a new cron job. Provide the full job definition including id, schedule (kind: cron|interval|one-shot), and action (kind: script|exec). Validate the schedule first with crontick_schedule_validate.',
      inputSchema: {
        id: z.string().regex(kebabCase, 'Job ID must be kebab-case (e.g. "my-job")'),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        schedule: ScheduleSchema,
        action: ActionSchema,
        catchup: z.enum(['run-once', 'run-all', 'skip']).optional(),
        overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
        retry: z
          .object({ max: z.number().int().min(0), backoffSec: z.number().positive() })
          .optional(),
        budgets: z
          .object({
            maxRunsPerDay: z.number().int().positive().nullable(),
            maxTokensPerRun: z.number().int().positive().nullable(),
          })
          .optional(),
      },
    },
    async (args) => toolWrap(() => callDaemon('POST', '/api/jobs', args)),
  );

  server.registerTool(
    'crontick_job_list',
    {
      description: 'List all scheduled jobs with their current status and next run time.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('GET', '/api/jobs')),
  );

  server.registerTool(
    'crontick_job_get',
    {
      description: 'Get the full definition and status of a specific job by ID.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() => callDaemon('GET', `/api/jobs/${encodeURIComponent(args.id)}`)),
  );

  server.registerTool(
    'crontick_job_update',
    {
      description:
        'Update an existing job. Provide the job ID and any fields to change (partial update is merged with existing definition).',
      inputSchema: {
        id: z.string(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        schedule: ScheduleSchema.optional(),
        action: ActionSchema.optional(),
        catchup: z.enum(['run-once', 'run-all', 'skip']).optional(),
        overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
        retry: z
          .object({ max: z.number().int().min(0), backoffSec: z.number().positive() })
          .optional(),
        budgets: z
          .object({
            maxRunsPerDay: z.number().int().positive().nullable(),
            maxTokensPerRun: z.number().int().positive().nullable(),
          })
          .optional(),
      },
    },
    async (args) => {
      const { id, ...patch } = args;
      return toolWrap(() =>
        callDaemon('PUT', `/api/jobs/${encodeURIComponent(id)}`, patch),
      );
    },
  );

  server.registerTool(
    'crontick_job_delete',
    {
      description:
        'Permanently delete a job and all its run history. This cannot be undone — confirm with the user first.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() => callDaemon('DELETE', `/api/jobs/${encodeURIComponent(args.id)}`)),
  );

  server.registerTool(
    'crontick_job_enable',
    {
      description: 'Enable a disabled job so it will run on its next scheduled time.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('POST', `/api/jobs/${encodeURIComponent(args.id)}/enable`),
      ),
  );

  server.registerTool(
    'crontick_job_disable',
    {
      description: 'Disable a job so it will not run until re-enabled.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('POST', `/api/jobs/${encodeURIComponent(args.id)}/disable`),
      ),
  );

  server.registerTool(
    'crontick_job_run_now',
    {
      description:
        'Trigger an immediate run of a job, bypassing its schedule. Returns a runId to track progress with crontick_run_get.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('POST', `/api/jobs/${encodeURIComponent(args.id)}/run`),
      ),
  );

  server.registerTool(
    'crontick_job_cancel_run',
    {
      description: 'Cancel an in-progress run by its run ID.',
      inputSchema: { runId: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('POST', `/api/runs/${encodeURIComponent(args.runId)}/cancel`),
      ),
  );

  // ── Runs ───────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_run_list',
    {
      description: 'List recent runs, optionally filtered by job ID.',
      inputSchema: {
        jobId: z.string().optional(),
        limit: z.number().int().positive().optional(),
        since: z.number().int().optional(),
      },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.jobId) params.set('jobId', args.jobId);
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      if (args.since !== undefined) params.set('since', String(args.since));
      const qs = params.toString();
      return toolWrap(() => callDaemon('GET', `/api/runs${qs ? `?${qs}` : ''}`));
    },
  );

  server.registerTool(
    'crontick_run_get',
    {
      description: 'Get the details and current status of a specific run by run ID.',
      inputSchema: { runId: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('GET', `/api/runs/${encodeURIComponent(args.runId)}`),
      ),
  );

  server.registerTool(
    'crontick_run_logs_tail',
    {
      description:
        'Get the last N lines of output for a run. Useful for diagnosing failures.',
      inputSchema: {
        runId: z.string(),
        lines: z.number().int().positive().default(50),
      },
    },
    async (args) =>
      toolWrap(async () => {
        const logs = (await callDaemon(
          'GET',
          `/api/runs/${encodeURIComponent(args.runId)}/logs`,
        )) as Array<{ stream: string; ts: number; data: string }>;
        const all = Array.isArray(logs) ? logs : [];
        const tail = all.slice(-args.lines);
        return { runId: args.runId, lines: tail };
      }),
  );

  // ── Schedules ─────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_schedule_validate',
    {
      description:
        'Validate a schedule definition. Returns ok:true and human-readable description on success, or an error message on failure. Always call this before creating a job.',
      inputSchema: {
        schedule: ScheduleSchema,
      },
    },
    async (args) =>
      toolWrap(() => callDaemon('POST', '/api/schedules/validate', args.schedule)),
  );

  server.registerTool(
    'crontick_schedule_preview',
    {
      description:
        'Preview the next N fire times for a schedule. Useful to confirm the schedule is what the user expects before creating the job.',
      inputSchema: {
        schedule: ScheduleSchema,
        n: z.number().int().positive().max(20).default(5),
        tz: z.string().optional(),
      },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('POST', '/api/schedules/preview', {
          schedule: args.schedule,
          n: args.n,
          tz: args.tz,
        }),
      ),
  );

  // ── Stats ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_stats_summary',
    {
      description:
        'Get an aggregate summary of all jobs: total count, enabled count, run history, success/failure counts, average duration.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('GET', '/api/stats/summary')),
  );

  server.registerTool(
    'crontick_stats_job',
    {
      description: 'Get run statistics for a specific job: total runs, success/failure rates, last status.',
      inputSchema: { id: z.string() },
    },
    async (args) =>
      toolWrap(() =>
        callDaemon('GET', `/api/stats/jobs/${encodeURIComponent(args.id)}`),
      ),
  );

  // ── Daemon ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_daemon_status',
    {
      description:
        'Get the daemon process status: PID, version, uptime, job counts, run stats, Node version, and platform.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('GET', '/health')),
  );

  server.registerTool(
    'crontick_daemon_reload',
    {
      description:
        'Reload job definitions from disk without restarting the daemon. Use after manually editing job files.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('POST', '/api/daemon/reload')),
  );

  server.registerTool(
    'crontick_daemon_restart',
    {
      description:
        'Restart the crontick daemon (stop + start). Running jobs will be interrupted. Confirm with the user before calling.',
      inputSchema: {},
    },
    async () =>
      toolWrap(async () => {
        // Kill existing daemon
        const pidFile = pidFilePath();
        if (existsSync(pidFile)) {
          try {
            const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
            if (!isNaN(pid)) process.kill(pid, 'SIGTERM');
          } catch { /* already dead */ }
        }
        // Wait for port file to disappear (up to 3s)
        await new Promise<void>((res) => {
          const deadline = Date.now() + 3000;
          const poll = setInterval(() => {
            if (!existsSync(portFilePath()) || Date.now() > deadline) {
              clearInterval(poll);
              res();
            }
          }, 100);
        });
        // Start new daemon
        const script = daemonScript();
        const restartChunks: Buffer[] = [];
        const child = spawn(process.execPath, [script], {
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: process.env,
        });
        if (child.stderr) {
          child.stderr.on('data', (chunk: Buffer) => {
            if (Buffer.concat(restartChunks).length < 4096) restartChunks.push(chunk);
          });
          (child.stderr as NodeJS.ReadableStream & { unref?(): void }).unref?.();
        }
        child.unref();
        const getRestartStderr = (): string => {
          const raw = Buffer.concat(restartChunks).toString('utf-8');
          return raw.length > 4096 ? raw.slice(0, 4096) + '…' : raw;
        };
        try {
          await waitForPortFile(10_000, getRestartStderr);
        } catch (err) {
          const stderr = getRestartStderr();
          if (stderr) appendAutostartLog(`daemon restart failed:\n${stderr}`);
          throw err;
        }
        return { ok: true, message: 'Daemon restarted successfully.' };
      }),
  );

  // ── Autostart ─────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_autostart_status',
    {
      description:
        'Check whether the crontick daemon is registered to start automatically at login. (v1: Windows uses HKCU Run; other platforms return manual instructions.)',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('GET', '/api/autostart/status')),
  );

  server.registerTool(
    'crontick_autostart_install',
    {
      description:
        'Register the crontick daemon to start automatically at login. (v1: Windows only via HKCU Run + VBS shim. On other platforms returns manual instructions.) On non-Windows, this returns a 501 with instructions to use manual autostart.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('POST', '/api/autostart/install', {})),
  );

  server.registerTool(
    'crontick_autostart_remove',
    {
      description: 'Remove the crontick daemon from the automatic startup registry.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('POST', '/api/autostart/remove', {})),
  );

  // ── Admin ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_export',
    {
      description:
        'Export all job definitions as a JSON object. Use this to back up or migrate jobs.',
      inputSchema: {},
    },
    async () => toolWrap(() => callDaemon('GET', '/api/export')),
  );

  server.registerTool(
    'crontick_import',
    {
      description:
        'Import job definitions from a JSON array. Jobs are upserted (existing jobs with the same ID are updated).',
      inputSchema: {
        jobs: z.array(z.unknown()),
      },
    },
    async (args) =>
      toolWrap(() => callDaemon('POST', '/api/import', { jobs: args.jobs })),
  );

  server.registerTool(
    'crontick_dashboard_open',
    {
      description:
        'Get the URL for the crontick dashboard web UI. Open it in a browser to view jobs and run history visually.',
      inputSchema: {},
    },
    async () =>
      toolWrap(async () => {
        const base = getDaemonBaseUrl();
        return {
          url: `${base}/dashboard`,
          message: `Dashboard available at: ${base}/dashboard — open in your browser.`,
        };
      }),
  );

  server.registerTool(
    'crontick_doctor',
    {
      description:
        'Run a suite of health checks: Node.js version, SQLite, data directory, daemon connectivity, dashboard reachability, autostart, and MCP server availability.',
      inputSchema: {},
    },
    async () => {
      const checks: Array<{ name: string; ok: boolean; note?: string }> = [];
      let daemonReachable = false;

      // Node version
      const major = parseInt(process.versions.node.split('.')[0], 10);
      checks.push({ name: 'Node.js >= 22.5', ok: major >= 22, note: `v${process.versions.node}` });

      // SQLite
      try {
        const { DatabaseSync } = await import('node:sqlite');
        new (DatabaseSync as new (path: string) => { close(): void })(':memory:').close();
        checks.push({ name: 'node:sqlite', ok: true });
      } catch (err) {
        checks.push({ name: 'node:sqlite', ok: false, note: String(err) });
      }

      // Data dir
      try {
        ensureDirs();
        checks.push({ name: 'data dir writable', ok: true });
      } catch (err) {
        checks.push({ name: 'data dir writable', ok: false, note: String(err) });
      }

      // Port file + daemon
      const portFile = portFilePath();
      const portFileExists = existsSync(portFile);
      checks.push({
        name: 'port file readable',
        ok: portFileExists,
        note: portFileExists ? portFile : 'not found',
      });

      try {
        const base = getDaemonBaseUrl();
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          daemonReachable = true;
          checks.push({ name: 'daemon reachable', ok: true });
        } else {
          checks.push({ name: 'daemon reachable', ok: false, note: `HTTP ${res.status}` });
        }
      } catch {
        checks.push({ name: 'daemon reachable', ok: false, note: 'not running' });
      }

      // Dashboard reachable
      try {
        const base = getDaemonBaseUrl();
        const dashRes = await fetch(`${base}/dashboard`, { signal: AbortSignal.timeout(2000) });
        const text = await dashRes.text();
        checks.push({
          name: 'dashboard reachable',
          ok: dashRes.status === 200 && text.includes('crontick'),
          note: dashRes.status === 200 ? 'ok' : `HTTP ${dashRes.status}`,
        });
      } catch {
        checks.push({ name: 'dashboard reachable', ok: false, note: 'daemon not running or no dashboard' });
      }

      // Autostart status
      if (daemonReachable) {
        try {
          const asResult = await callDaemon('GET', '/api/autostart/status');
          const as = asResult as { installed?: boolean; backend?: string };
          checks.push({
            name: 'autostart',
            ok: true,
            note: `backend=${as.backend ?? '?'}, installed=${String(as.installed ?? false)}`,
          });
        } catch {
          checks.push({ name: 'autostart', ok: false, note: 'could not check (daemon not running)' });
        }
      } else {
        checks.push({ name: 'autostart', ok: false, note: 'could not check (daemon not running)' });
      }

      // MCP server binary
      const mcpScript = pathResolve(__dirname, '../mcp/index.js');
      checks.push({
        name: 'MCP server binary',
        ok: existsSync(mcpScript),
        note: mcpScript,
      });

      const allOk = checks.every((c) => c.ok);
      return okResult({ ok: allOk, checks });
    },
  );

  // ── Resources ─────────────────────────────────────────────────────────────

  // crontick://jobs — list of job IDs
  server.resource(
    'crontick-jobs-list',
    'crontick://jobs',
    {
      description: 'List of all crontick job IDs',
      mimeType: 'application/json',
    },
    async () => {
      try {
        await ensureDaemon();
        const jobs = (await callDaemon('GET', '/api/jobs')) as Array<{ id: string }>;
        const ids = Array.isArray(jobs) ? jobs.map((j) => j.id) : [];
        return {
          contents: [
            {
              uri: 'crontick://jobs',
              mimeType: 'application/json',
              text: JSON.stringify({ jobIds: ids }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: 'crontick://jobs',
              mimeType: 'application/json',
              text: JSON.stringify({ error: String(err) }, null, 2),
            },
          ],
        };
      }
    },
  );

  // crontick://jobs/{id} — single job JSON
  const jobTemplate = new ResourceTemplate('crontick://jobs/{id}', {
    list: async () => ({
      resources: [],
    }),
  });

  server.resource(
    'crontick-job',
    jobTemplate,
    { description: 'Full job definition as JSON', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      try {
        await ensureDaemon();
        const job = await callDaemon('GET', `/api/jobs/${encodeURIComponent(String(id ?? ''))}`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(job, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: String(err) }, null, 2),
            },
          ],
        };
      }
    },
  );

  // crontick://runs/{id} — single run record
  const runTemplate = new ResourceTemplate('crontick://runs/{id}', {
    list: async () => ({ resources: [] }),
  });

  server.resource(
    'crontick-run',
    runTemplate,
    { description: 'Run record as JSON', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      try {
        await ensureDaemon();
        const run = await callDaemon('GET', `/api/runs/${encodeURIComponent(String(id ?? ''))}`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(run, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: String(err) }, null, 2),
            },
          ],
        };
      }
    },
  );

  // crontick://runs/{id}/log — full log text
  const runLogTemplate = new ResourceTemplate('crontick://runs/{id}/log', {
    list: async () => ({ resources: [] }),
  });

  server.resource(
    'crontick-run-log',
    runLogTemplate,
    { description: 'Full log output for a run as plain text', mimeType: 'text/plain' },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      try {
        await ensureDaemon();
        const logs = (await callDaemon(
          'GET',
          `/api/runs/${encodeURIComponent(String(id ?? ''))}/logs`,
        )) as Array<{ stream: string; data: string; ts: number }>;
        const text = Array.isArray(logs)
          ? logs.map((l) => `[${l.stream}] ${l.data}`).join('')
          : '';
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text }],
        };
      } catch (err) {
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Error: ${String(err)}` }],
        };
      }
    },
  );

  // crontick://schemas/job — JSON schema for a job
  server.resource(
    'crontick-schema-job',
    'crontick://schemas/job',
    { description: 'JSON Schema for a crontick job definition', mimeType: 'application/json' },
    async () => {
      const schema = zodToJsonSchema(JobSchema as unknown as Parameters<typeof zodToJsonSchema>[0], { name: 'CrontickJob' });
      return {
        contents: [
          {
            uri: 'crontick://schemas/job',
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      };
    },
  );

  // ── Prompts ────────────────────────────────────────────────────────────────

  server.prompt(
    'create-scheduled-script',
    'Guide the LLM through creating a new scheduled script job: understand intent, draft a self-contained shell script, validate/preview the schedule, then create the job.',
    {
      intent: z.string(),
      os: z.enum(['windows', 'unix']).optional(),
    },
    (args) => {
      const shell = args.os === 'windows' ? 'PowerShell' : 'bash';
      const shellHint = args.os === 'windows' ? 'pwsh' : 'bash';
      return {
        description: 'Create a new scheduled script job',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `You are helping me schedule an automated task with crontick.

My intent: ${args.intent}

Please follow these steps in order:

**Step 1 — Understand the intent**
Clarify what the task does, when it should run, and any side effects or requirements.

**Step 2 — Draft the script**
Write a self-contained ${shell} script that accomplishes the task idempotently.
- The script must not rely on external state set up by other scripts.
- If it calls an LLM CLI (e.g. \`copilot\`, \`claude\`), that command goes inside the script.
- Use error handling: \`set -euo pipefail\` for bash, \`$ErrorActionPreference = 'Stop'\` for ${shell}.

**Step 3 — Choose a schedule**
Decide on the cron expression or interval. Then call:
- \`crontick_schedule_validate\` with \`schedule: { kind: "cron", cron: "<expr>", tz: "<tz>" }\`
- \`crontick_schedule_preview\` to show the next 5 fire times to the user for confirmation.

**Step 4 — Create the job**
Once the user approves the schedule, call \`crontick_job_create\` with \`action.kind: "script"\`:
\`\`\`json
{
  "id": "<kebab-case-id>",
  "description": "<one-line description>",
  "schedule": { "kind": "cron", "cron": "<expr>", "tz": "<tz>" },
  "action": {
    "kind": "script",
    "script": "<full script body>",
    "shell": "${shellHint}"
  }
}
\`\`\`

**Step 5 — Confirm**
Report the returned job ID and next run time to the user.
Always confirm before calling crontick_job_delete or crontick_job_disable.`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    'investigate-failed-run',
    'Load a failed run record and its logs, then help diagnose the failure and propose a fix.',
    {
      runId: z.string(),
    },
    async (args) => {
      let runInfo = 'Run record unavailable.';
      let logInfo = 'Logs unavailable.';

      try {
        await ensureDaemon();
        const run = await callDaemon('GET', `/api/runs/${encodeURIComponent(args.runId)}`);
        runInfo = JSON.stringify(run, null, 2);
      } catch (err) {
        runInfo = `Error fetching run: ${String(err)}`;
      }

      try {
        const logs = (await callDaemon(
          'GET',
          `/api/runs/${encodeURIComponent(args.runId)}/logs`,
        )) as Array<{ stream: string; data: string }>;
        const lines = Array.isArray(logs) ? logs.slice(-100) : [];
        logInfo =
          lines.length > 0
            ? lines.map((l) => `[${l.stream}] ${l.data}`).join('')
            : '(no log output)';
      } catch (err) {
        logInfo = `Error fetching logs: ${String(err)}`;
      }

      return {
        description: `Investigate failed run ${args.runId}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please investigate why run \`${args.runId}\` failed and propose a fix.

## Run Record
\`\`\`json
${runInfo}
\`\`\`

## Last 100 Log Lines
\`\`\`
${logInfo}
\`\`\`

## What to diagnose
1. What caused the failure? (exit code, timeout, budget exceeded, script error, etc.)
2. Is this a one-time fluke or likely to recur?
3. Proposed fix — choose the most appropriate:
   - **Script fix**: edit the script body via \`crontick_job_update\` with a corrected \`action.script\`
   - **Schedule change**: adjust timing/tz via \`crontick_job_update\` with a new \`schedule\`
   - **Retry policy**: increase retry max via \`crontick_job_update\` with \`retry.max\`
   - **Budget cap**: set \`budgets.maxRunsPerDay\` if it's running too often
   - **Timeout**: increase \`action.timeoutSec\` if the job was killed by timeout
4. After proposing the fix, ask for user confirmation before applying it.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive until transport closes
}

main().catch((err) => {
  process.stderr.write(`[crontick-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
