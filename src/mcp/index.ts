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
import { ScheduleSchema } from '../schemas/job.js';
import { EngineConfigSchema } from '../schemas/config.js';
import { JobCreateInputSchema, JobPatchInputSchema } from '../job-input.js';
import { createClient, type CrontickClient } from '../client.js';
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
    // Loopback address:port
    .replace(/127\.0\.0\.1:\d+/g, '<daemon-addr>')
    // Windows absolute paths: C:\foo\bar  (must have at least one separator)
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    // POSIX absolute paths: only when preceded by start-of-string, whitespace,
    // (, [, or a quote — to avoid matching /path inside http://host/path URLs.
    .replace(/(^|[\s(["'])\/(?:[^\s"'/]+\/)+[^\s"'/]+/g, '$1<path>');
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

function redactedErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
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

type SingleRunIdArgs = RawArgs & { id?: string; runId?: string };

const DEPRECATED_RUN_ID_DESCRIPTION = 'Deprecated alias for id. If both are provided, id wins.';

function normalizeSingleRunId(args: SingleRunIdArgs): string {
  if (typeof args.id === 'string' && args.id.length > 0) return args.id;
  if (typeof args.runId === 'string' && args.runId.length > 0) return args.runId;
  throw new Error('Missing required identifier: provide id (preferred) or deprecated runId.');
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
        'Create and schedule a new cron job. This executes arbitrary commands, scripts, or prompts on the user\'s machine on a recurring or future schedule that persists and outlives this session -- confirm the job definition (schedule and action) with the user before calling. Provide the full job definition including id, schedule (kind: cron|interval|one-shot), and action (kind: script|exec|prompt). Prompt actions use prompt, optional configured engine name, args, sessionId, or reuseSession. Validate the schedule first with crontick_schedule_validate.',
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
      description: 'Get the full definition and status of a specific job by ID.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getJob(args.id)),
  );

  server.registerTool(
    'crontick_job_update',
    {
      description:
        'Update an existing job. Provide the job ID and any fields to change (partial update is merged with existing definition). Action can be script, exec, or prompt.',
      inputSchema: withVerbose({
id: z.string(),
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
        'Permanently delete a job and all its run history. This cannot be undone — confirm with the user first.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.deleteJob(args.id)),
  );

  server.registerTool(
    'crontick_job_enable',
    {
      description: 'Enable a disabled job so it will run on its next scheduled time.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.enableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_disable',
    {
      description: 'Disable a job so it will not run until re-enabled.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.disableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_run_now',
    {
      description:
        'Trigger an immediate run of a job, bypassing its schedule. This executes the job\'s command, script, or prompt on the user\'s machine right now -- confirm with the user before calling. Returns a runId to track progress with crontick_run_get.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.runNow(args.id)),
  );

  server.registerTool(
    'crontick_job_cancel_run',
    {
      description: 'Cancel an in-progress run by its run ID. Prefer `id`; deprecated alias: `runId`.',
      inputSchema: withVerbose({
        id: z.string().optional(),
        runId: z.string().optional().describe(DEPRECATED_RUN_ID_DESCRIPTION),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.cancelRun(normalizeSingleRunId(args))),
  );

  // ── Runs ───────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_run_list',
    {
      description: 'List recent runs, optionally filtered by job ID and/or status. Status includes the terminal "missed" state for schedule fires that were recorded but never executed because the daemon was down.',
      inputSchema: withVerbose({
        jobId: z.string().optional(),
        limit: z.number().int().positive().optional(),
        since: z.number().int().optional(),
        status: z.enum(['queued', 'running', 'success', 'failed', 'canceled', 'timeout', 'missed']).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.listRuns(withoutVerbose(args))),
  );

  server.registerTool(
    'crontick_run_get',
    {
      description: 'Get the details and current status of a specific run. Prefer `id`; deprecated alias: `runId`. Includes the run pid (if it was spawned) and whether its output was truncated by the retention output cap.',
      inputSchema: withVerbose({
        id: z.string().optional(),
        runId: z.string().optional().describe(DEPRECATED_RUN_ID_DESCRIPTION),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getRun(normalizeSingleRunId(args))),
  );

  server.registerTool(
    'crontick_run_logs_tail',
    {
      description:
        'Get the last N lines of output for a run. Prefer `id`; deprecated alias: `runId`. Useful for diagnosing failures.',
      inputSchema: withVerbose({
        id: z.string().optional(),
        runId: z.string().optional().describe(DEPRECATED_RUN_ID_DESCRIPTION),
        lines: z.number().int().positive().default(50),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getLogs(normalizeSingleRunId(args), { lines: args.lines })),
  );

  // ── Schedules ─────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_schedule_validate',
    {
      description:
        'Validate a schedule definition. Returns ok:true and human-readable description on success, or an error message on failure. Always call this before creating a job.',
      inputSchema: withVerbose({
        schedule: ScheduleSchema,
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.validateSchedule(args.schedule)),
  );

  server.registerTool(
    'crontick_schedule_preview',
    {
      description:
        'Preview the next N fire times for a schedule. Useful to confirm the schedule is what the user expects before creating the job.',
      inputSchema: withVerbose({
        schedule: ScheduleSchema,
        n: z.number().int().positive().max(20).default(5),
        tz: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.previewSchedule({ schedule: args.schedule, n: args.n, tz: args.tz })),
  );

  // ── Stats ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_stats_summary',
    {
      description:
        'Get an aggregate summary of all jobs: total count, enabled count, run history, success/failure counts, average duration.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.statsSummary()),
  );

  server.registerTool(
    'crontick_stats_job',
    {
      description: 'Get run statistics for a specific job: total runs, success/failure rates, last status.',
      inputSchema: withVerbose({ id: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.statsJob(args.id)),
  );

  // ── Daemon ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_daemon_start',
    {
      description:
        'Start the local crontick daemon. Returns the daemon port and whether this call started a new process.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonStart()),
  );

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
    'crontick_daemon_status',
    {
      description:
        'Get the daemon process status: PID, version, uptime, job counts, and a missedFires summary (jobs whose schedule missed fires while the daemon was down since the last start — report-only, never auto-executed; see crontick_run_list with status "missed").',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    // daemon_status returns a soft error object instead of isError:true — the
    // LLM should know the daemon is down without treating it as a tool failure.
    async (args) => {
      const diagnostics: LogEvent[] = [];
      const verbose = mcpVerbose(args);
      const client = mcpClient(false, { verbose, diagnostics });
      try {
        return okResult(await client.daemonStatus(), diagnostics, verbose);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return okResult({ running: false, error: redactForLlm(msg) }, diagnostics, verbose);
      }
    },
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

  server.registerTool(
    'crontick_daemon_restart',
    {
      description:
        'Restart the crontick daemon (stop + start). Running jobs will be interrupted. Confirm with the user before calling.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonRestart()),
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
        'Import job definitions from a JSON array. Jobs are upserted (existing jobs with the same ID are updated), each import persisting recurring jobs that execute arbitrary commands, scripts, or prompts on the user\'s machine -- confirm the imported job definitions with the user before calling. An optional runs array (as produced by crontick_export with includeRuns) is restored archivally: no execution, no scheduler interaction.',
      inputSchema: withVerbose({
        jobs: z.array(z.unknown()),
        runs: z.array(z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.importJobs(args.jobs, { runs: args.runs })),
  );

  server.registerTool(
    'crontick_dashboard_start',
    {
      description:
        'Start the crontick dashboard server and return its URL. The dashboard is served by the local daemon.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.dashboardStart()),
  );

  server.registerTool(
    'crontick_dashboard_status',
    {
      description:
        'Return dashboard server status without starting it. If it is down, start it with crontick_dashboard_start.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.dashboardStatus(), false),
  );

  server.registerTool(
    'crontick_dashboard_data',
    {
      description:
        'Return the core dashboard data model: health, aggregate stats, jobs, and recent runs.',
      inputSchema: withVerbose({
        jobId: z.string().optional(),
        runsLimit: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.dashboardData(withoutVerbose(args)), false),
  );

  server.registerTool(
    'crontick_dashboard_stop',
    {
      description:
        'Stop the daemon-backed dashboard server. This also stops the local daemon because the dashboard is served by it.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.dashboardStop(), false),
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

  // ── Config ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_config_get',
    {
      description: 'Get the effective crontick config, or a single value by dot-separated path.',
      inputSchema: withVerbose({ path: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.getConfigValue(args.path)), false),
  );

  server.registerTool(
    'crontick_config_set',
    {
      description: 'Set one crontick config value by dot-separated path. The updated config is validated and returned.',
      inputSchema: withVerbose({ path: z.string(), value: z.unknown() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.setConfigValue(args.path, args.value)), false),
  );

  server.registerTool(
    'crontick_config_unset',
    {
      description: 'Remove one crontick config value by dot-separated path. The updated config is validated and returned.',
      inputSchema: withVerbose({ path: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.removeConfigValue(args.path)), false),
  );

  server.registerTool(
    'crontick_config_engine_list',
    {
      description: 'List configured prompt engines from the effective crontick config.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.listEngines()), false),
  );

  server.registerTool(
    'crontick_config_engine_add',
    {
      description: 'Add a prompt engine. The engine defines the command, default args, and default env used when prompt jobs run.',
      inputSchema: withVerbose({ name: z.string(), engine: EngineConfigSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.addEngine(args.name, args.engine)), false),
  );

  server.registerTool(
    'crontick_config_engine_update',
    {
      description: 'Update a prompt engine. Provided fields replace the existing command, args, or env.',
      inputSchema: withVerbose({ name: z.string(), engine: EngineConfigSchema.partial() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.updateEngine(args.name, args.engine)), false),
  );

  server.registerTool(
    'crontick_config_engine_remove',
    {
      description: 'Remove a prompt engine. You cannot remove the current defaultEngine.',
      inputSchema: withVerbose({ name: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.removeEngine(args.name)), false),
  );

  server.registerTool(
    'crontick_config_init',
    {
      description: 'Create the default crontick config file. Use force:true to replace an existing file.',
      inputSchema: withVerbose({ force: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.initConfig({ force: args.force })), false),
  );

  server.registerTool(
    'crontick_config_validate',
    {
      description: 'Validate the current crontick config file, or a specific config file path.',
      inputSchema: withVerbose({ path: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.validateConfig(args.path)), false),
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
