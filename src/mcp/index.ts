/**
 * MCP server shim — thin adapter over CrontickClient via stdio transport.
 * Registers tools whose input schemas are derived from shared Zod schemas and
 * delegates all operations to the client. Contains no business logic; the only
 * MCP-specific behavior is error redaction (redactForLlm) and result shaping.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { VERSION } from '../version.js';
import { JobCreateInputSchema, JobPatchInputSchema } from '../job-input.js';
import { createClient, type CrontickClient } from '../client.js';
import { LOG_SOURCES } from '../log-source.js';
import { isVerboseEnv, type LogEvent } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function daemonScript(): string {
  return pathResolve(__dirname, '../daemon/index.js');
}

/** CRONTICK_MCP_START_DAEMON=0 disables demand-start (for testing or explicit control). */
function shouldStartDaemon(): boolean {
  return process.env['CRONTICK_MCP_START_DAEMON'] !== '0';
}

function mcpScript(): string {
  return pathResolve(__dirname, '../mcp/index.js');
}

type VerboseArgs = { verbose?: boolean };
type RawArgs = Record<string, unknown> & VerboseArgs;

const VERBOSE_INPUT = { verbose: z.boolean().optional() };

/** Appends the optional `verbose` boolean to any tool's input schema. */
function withVerbose<T extends Record<string, unknown>>(schema: T): T & typeof VERBOSE_INPUT {
  return { ...schema, ...VERBOSE_INPUT };
}

function mcpVerbose(args?: VerboseArgs): boolean {
  return args?.verbose === true || isVerboseEnv();
}

function mcpClient(startDaemon = shouldStartDaemon(), options: { verbose?: boolean; diagnostics?: LogEvent[] } = {}) {
  const verbose = options.verbose ?? isVerboseEnv();
  return createClient({
    daemonScript: daemonScript(),
    startDaemon,
    mcpScript: mcpScript(),
    cwd: process.cwd(),
    verbose,
    onLog: options.diagnostics ? (event) => options.diagnostics?.push(event) : undefined,
  });
}

// ── Tool result helpers ───────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function okResult(data: unknown, diagnostics: LogEvent[] = [], verbose = false): ToolResult {
  const payload = verbose && diagnostics.length > 0 ? { result: data, diagnostics } : data;
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Security: strip loopback addresses and filesystem paths from error text
 * before returning to the LLM host. Prevents leaking machine-specific details
 * (port numbers, user home directories) into model context. Exported for testing.
 */
export function redactForLlm(msg: string): string {
  return msg
    // IPv4 loopback address:port
    .replace(/127\.0\.0\.1:\d+/g, '<daemon-addr>')
    // IPv6 loopback: [::1]:port, ::1:port, or bare ::1 (bracketed form first
    // so its :port isn't swallowed by the bare-::1 pass).
    .replace(/\[::1\](?::\d+)?/g, '<daemon-addr>')
    .replace(/::1(?::\d+)?/g, '<daemon-addr>')
    // Windows absolute paths: C:\foo\bar  (must have at least one separator)
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    // POSIX absolute paths, including single-segment roots like /tmp, /etc,
    // /home: only when preceded by start-of-string, whitespace, (, [, or a
    // quote — to avoid matching /path inside http://host/path URLs. The
    // segment group is `*` (not `+`) so `/tmp` matches, not just `/a/b`.
    .replace(/(^|[\s(["'])\/(?:[^\s"'/]+\/)*[^\s"'/]+/g, '$1<path>');
}

function errResult(err: unknown, diagnostics: LogEvent[] = [], verbose = false): ToolResult {
  const redacted = redactedErrorMessage(err);
  const payload = verbose && diagnostics.length > 0
    ? { error: redacted, diagnostics }
    : { error: redacted };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/** Redact an error's message for return to the LLM host. Exported for testing. */
export function redactedErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // ENV_FILE_ERROR messages embed the resolved env-file absolute path; redact
  // it too so no machine-specific path leaks into the LLM host context.
  return redactForLlm(msg);
}

/** Core handler pattern: create client, call fn, shape result or redact error. */
async function toolWrap(args: VerboseArgs | undefined, fn: (client: CrontickClient) => Promise<unknown>, startDaemon = shouldStartDaemon()): Promise<ToolResult> {
  const diagnostics: LogEvent[] = [];
  const verbose = mcpVerbose(args);
  const client = mcpClient(startDaemon, { verbose, diagnostics });
  try {
    const result = await fn(client);
    const notices = client.drainNotices();
    const data = notices.length > 0 ? { result, notices } : result;
    return okResult(data, diagnostics, verbose);
  } catch (err) {
    return errResult(err, diagnostics, verbose);
  }
}

/** Strip the shim-only `verbose` key before forwarding args to the client. */
function withoutVerbose<T extends RawArgs>(args: T): Omit<T, 'verbose'> {
  const rest = { ...args };
  delete rest.verbose;
  return rest;
}

// ── MCP server setup ──────────────────────────────────────────────────────────

/** Build and return the McpServer with all tools registered. Separated from main() for testing. */
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
        'Create and schedule a new cron job. This executes an AI prompt on the user\'s machine on a recurring or future schedule that persists and outlives this session -- confirm the job definition (schedule and action) with the user before calling. Provide the job definition: schedule (kind: cron|interval|one-shot) and action (kind: prompt) are required; id (GUID) is generated automatically and should be omitted; alias is the job\'s optional, unique, human-friendly name (the CLI --name flag) -- when omitted, one is auto-generated. Exactly one schedule is allowed per job: cron (expression), interval (everySec, in seconds), or one-shot (runAt, ISO-8601, interpreted in the machine local timezone unless an offset such as Z or +02:00 is given). Prompt actions use prompt, optional configured engine name, args, sessionId, or reuseSession. After creating, use crontick_job_schedule to preview the job\'s upcoming fire times.',
      inputSchema: withVerbose({
        ...JobCreateInputSchema.shape,
        force: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const { force, verbose: _verbose, ...input } = args;
      void _verbose;
      return toolWrap(args, (client) => client.createJob(input, { force }));
    },
  );

  server.registerTool(
    'crontick_job_list',
    {
      description: 'List all scheduled jobs with their current status and next run time.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.listJobs()),
  );

  server.registerTool(
    'crontick_job_get',
    {
      description: 'Get the full definition and status of a specific job by id or name.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or name') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getJob(args.id)),
  );

  server.registerTool(
    'crontick_job_update',
    {
      description:
        'Update an existing job (id or name). Provide the job identifier and any fields to change (partial update is merged with existing definition); the alias (name) can be changed here (must remain unique). Action is always a prompt action.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or name'),
        ...JobPatchInputSchema.shape,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const { id, ...patch } = args;
      return toolWrap(args, (client) => client.updateJob(id, withoutVerbose(patch)));
    },
  );

  server.registerTool(
    'crontick_job_delete',
    {
      description:
        'Permanently delete one job definition by id/name, or delete every job with all:true plus force:true. Archived runs and logs remain directly queryable by run ID, but live aggregates exclude deleted jobs. This may cancel an in-flight run and cannot be undone -- confirm with the user first.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or name to delete individually').optional(),
        all: z.boolean().optional().describe('Delete every job. Requires force:true.'),
        force: z.boolean().optional().describe('Confirm a bulk delete when all:true.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.all) {
        if (args.id) return errResult(new Error('Provide either id or all:true, not both'));
        return toolWrap(args, (client) => client.deleteJob(undefined, { all: true, force: args.force }));
      }
      if (!args.id) return errResult(new Error('Provide id, or set all:true with force:true to delete every job'));
      return toolWrap(args, (client) => client.deleteJob(args.id));
    },
  );

  server.registerTool(
    'crontick_job_enable',
    {
      description: 'Enable a disabled job (id or name) so it will run on its next scheduled time.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or name') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.enableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_disable',
    {
      description: 'Disable a job (id or name) so it will not run until re-enabled.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or name') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.disableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_run_now',
    {
      description:
        'Run a job (id or name) once, right now, even if it is disabled -- it is NOT enabled and its schedule is not changed (an enabled job keeps running on its normal schedule). The overlap policy still applies (with overlap=skip and a run already active, the run is recorded as skipped). This executes the job\'s prompt on the user\'s machine right now -- confirm with the user before calling. Returns a runId to track progress with crontick_run_get.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or name') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.runNow(args.id)),
  );

  server.registerTool(
    'crontick_job_cancel_run',
    {
      description: 'Cancel an in-progress run by its run ID.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.cancelRun(args.id)),
  );

  // ── Runs ───────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_run_list',
    {
      description: 'List recent runs, optionally filtered by job (id or name) and/or status. Status includes the terminal "missed" state for schedule fires that were recorded but never executed because the daemon was down.',
      inputSchema: withVerbose({
        jobId: z.string().describe('Job id (GUID) or name').optional(),
        limit: z.number().int().positive().optional(),
        since: z.number().int().optional(),
        status: z.enum(['queued', 'running', 'success', 'failed', 'canceled', 'skipped', 'timeout', 'missed']).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.listRuns(withoutVerbose(args))),
  );

  server.registerTool(
    'crontick_run_get',
    {
      description: 'Get run details and status, including Claude cost, turns, redacted usage, transcript path, and engine status when available.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getRun(args.id)),
  );

  server.registerTool(
    'crontick_run_logs_tail',
    {
      description:
        'Get the last N lines of output for a run. Useful for diagnosing failures. Use the source filter to select engine output (stdout+stderr), crontick scheduling/execution events, or all (default).',
      inputSchema: withVerbose({
        id: z.string(),
        lines: z.number().int().positive().default(50),
        source: z.enum(LOG_SOURCES).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getLogs(args.id, { lines: args.lines, source: args.source })),
  );


  server.registerTool(
    'crontick_job_schedule',
    {
      description:
        'Show the next N upcoming fire times for an existing job (id or name). Useful to confirm a job\'s schedule is what the user expects.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or name'),
        n: z.number().int().positive().max(20).default(5),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.jobSchedule(args.id, { n: args.n })),
  );

  // ── Stats ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_stats_summary',
    {
      description:
        'Get aggregate job/run counts, average duration, total engine cost in USD, and total turns.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.statsSummary()),
  );

  server.registerTool(
    'crontick_stats_job',
    {
      description: 'Get run counts, last status, total engine cost in USD, and total turns for one job (id or name).',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or name') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.statsJob(args.id)),
  );

  // ── Daemon ─────────────────────────────────────────────────────────────────


  server.registerTool(
    'crontick_daemon_stop',
    {
      description:
        'Stop the local crontick daemon gracefully (HTTP shutdown, falling back to a hard kill only if unresponsive). In-flight runs are detached and keep running; they are adopted by the next daemon start rather than being interrupted. Confirm with the user before calling.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonStop(), false),
  );


  server.registerTool(
    'crontick_daemon_reload',
    {
      description:
        'Reload job definitions from disk without restarting the daemon. Use after manually editing job files.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonReload()),
  );


  // ── Admin ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_export',
    {
      description:
        'Export all job definitions as a JSON object. Use this to back up or migrate jobs. Set includeRuns to also include run history (the mitigation for retention\'s hard-delete of old runs).',
      inputSchema: withVerbose({
        includeRuns: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.exportJobs({ includeRuns: args.includeRuns })),
  );

  server.registerTool(
    'crontick_import',
    {
      description:
        'Import job definitions from a JSON array. Jobs are upserted (existing jobs with the same ID are updated), each import persisting recurring jobs that execute AI prompts on the user\'s machine -- confirm the imported job definitions with the user before calling. An optional runs array (as produced by crontick_export with includeRuns) is restored archivally: no execution, no scheduler interaction.',
      inputSchema: withVerbose({
        jobs: z.array(z.unknown()),
        runs: z.array(z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.importJobs(args.jobs, { runs: args.runs })),
  );

  server.registerTool(
    'crontick_doctor',
    {
      description:
        'Run a suite of health checks: Node.js version, SQLite, data directory, daemon connectivity, dashboard reachability, and MCP server availability.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.doctor({ mcpScript: mcpScript() }), false),
  );


  server.registerTool(
    'crontick_info',
    {
      description:
        'Return crontick environment info: crontick and Node versions, configPath, all on-disk file locations (data dir, jobs dir, logs dir, runs DB, config file, port file, daemon pid file), the dashboard URL (dashboardUrl), and daemon running status. The dashboard is always served by the daemon; open dashboardUrl in a browser.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.info(), false),
  );

  // ── Resources ─────────────────────────────────────────────────────────────

  // crontick://schemas/job — JSON schema for a job
  server.resource(
    'crontick-schema-job',
    'crontick://schemas/job',
    { description: 'JSON Schema for a crontick job definition', mimeType: 'application/json' },
    async () => {
      const schema = mcpClient(false).jobJsonSchema();
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

  return server;
}

// ── Entry point ────────────────────────────────────────────────────────────────

/** Entry point: connect the MCP server to stdin/stdout JSON-RPC transport. */
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
