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
import { isVerboseEnv, type LogEvent } from '../logger.js';
import { redactSmeeUrlsInText, redactWebhookDeep } from '../utils/webhook-redact.js';

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

const JOB_IN_FLIGHT_INPUT = z.enum(['stop', 'wait']).optional().describe(
  'Only needed when the job has runs in flight (the call then fails with RUNS_IN_FLIGHT listing them): "stop" cancels them (and drops queued ones) then applies; "wait" pauses the job, waits for them to finish, applies, then resumes it. Ask the user which before choosing.',
);

const TRUST_FOLDER_INPUT = z.boolean().optional().describe(
  'Claude only: trust the job\'s working directory when it is not trusted yet. If the call fails with TRUST_REQUIRED, ask the user whether to trust that folder and only then call again with trustFolder: true.',
);

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

/**
 * LLM-facing redaction for tool results (separate from `redactValue`): webhook relay URLs become
 * `https://smee.io/Uk…Sd`, `secret` becomes `set`, and smee.io URLs in free text (notices) are masked.
 * Exported for testing.
 */
export function redactForLlmValue(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSmeeUrlsInText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, e]) => [k, walk(e)]));
    }
    return v;
  };
  return walk(redactWebhookDeep(value));
}

function okResult(data: unknown, diagnostics: LogEvent[] = [], verbose = false, redact = true): ToolResult {
  if (redact) data = redactForLlmValue(data);
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
async function toolWrap(args: VerboseArgs | undefined, fn: (client: CrontickClient) => Promise<unknown>, startDaemon = shouldStartDaemon(), redact = true): Promise<ToolResult> {
  const diagnostics: LogEvent[] = [];
  const verbose = mcpVerbose(args);
  const client = mcpClient(startDaemon, { verbose, diagnostics });
  try {
    const result = await fn(client);
    const notices = client.drainNotices();
    const data = notices.length > 0 ? { result, notices } : result;
    return okResult(data, diagnostics, verbose, redact);
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
        'Create and schedule a new cron job. This executes an AI prompt on the user\'s machine on a recurring or future schedule that persists and outlives this session -- confirm the job definition (schedule and action) with the user before calling. Provide the job definition: schedule (kind: cron|interval|one-shot|after) and action (kind: prompt) are required; id (GUID) is generated automatically and should be omitted; alias is the job\'s optional, unique, kebab-case identifier (set via CLI `--alias`) -- when omitted, one is auto-generated. Exactly one schedule is allowed per job: cron (expression), interval (everySec, in seconds), one-shot (runAt, ISO-8601, interpreted in the machine local timezone unless an offset such as Z or +02:00 is given), or after (jobId = upstream job id or alias, status = success|failure|any: runs when the upstream job finishes with that outcome; the alias is stored as the upstream GUID). catchUp (boolean, default false) runs the most recent missed fire once after downtime and is only valid for cron, interval and one-shot schedules. Prompt actions use prompt, optional configured engine name, args, sessionId, reuseSession, or cwd. sessionId resumes an existing session (including one created outside crontick) on every run and implies reuse; reuseSession instead starts a new session on the first run and resumes it afterwards. Both require overlap: skip. Always pass action.cwd as the absolute path of the project folder the job should run in: MCP hosts often start this server in an unrelated directory (such as /), which would otherwise become the job\'s working directory. After creating, use crontick_job_schedule to preview the job\'s upcoming fire times.',
      inputSchema: withVerbose({
        ...JobCreateInputSchema.shape,
        force: z.boolean().optional(),
        trustFolder: TRUST_FOLDER_INPUT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const { force, trustFolder, verbose: _verbose, ...input } = args;
      void _verbose;
      return toolWrap(args, (client) => client.createJob(input, { force, trustFolder }));
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
      description: 'Get the full definition and status of a specific job by id or alias.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or alias') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.getJob(args.id)),
  );

  server.registerTool(
    'crontick_job_update',
    {
      description:
        'Update an existing job (id or alias). Provide the job identifier and any fields to change (partial update is merged with existing definition; a schedule of kind after takes jobId = upstream id or alias and status = success|failure|any); catchUp (boolean) turns missed-fire catch-up on/off for cron, interval and one-shot jobs and is left unchanged when omitted; the alias can be changed here (must remain unique). Action is always a prompt action.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or alias'),
        ...JobPatchInputSchema.shape,
        trustFolder: TRUST_FOLDER_INPUT,
        inFlight: JOB_IN_FLIGHT_INPUT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const { id, trustFolder, inFlight, ...patch } = args;
      return toolWrap(args, (client) => client.updateJob(id, withoutVerbose(patch), { trustFolder, inFlight }));
    },
  );

  server.registerTool(
    'crontick_job_delete',
    {
      description:
        'Permanently delete one job definition by id/alias (refused with JOB_HAS_DEPENDENTS when other jobs are triggered after it, unless force:true), or delete every job with all:true plus force:true. The job\'s run history and logs are deleted with it (Claude\'s own session transcripts are not touched). This may cancel an in-flight run and cannot be undone -- confirm with the user first.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or alias to delete individually').optional(),
        all: z.boolean().optional().describe('Delete every job. Requires force:true.'),
        force: z.boolean().optional().describe('With all:true: confirm a bulk delete. With id: delete the job even though other jobs run after it (they are disabled and keep a dangling upstream ref).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.all) {
        if (args.id) return errResult(new Error('Provide either id or all:true, not both'));
        return toolWrap(args, (client) => client.deleteJob(undefined, { all: true, force: args.force }));
      }
      if (!args.id) return errResult(new Error('Provide id, or set all:true with force:true to delete every job'));
      return toolWrap(args, (client) => client.deleteJob(args.id, { force: args.force }));
    },
  );

  server.registerTool(
    'crontick_job_enable',
    {
      description: 'Enable a disabled job (id or alias) so it will run on its next scheduled time.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or alias') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.enableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_disable',
    {
      description: 'Disable a job (id or alias) so it will not run until re-enabled.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or alias') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.disableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_run_now',
    {
      description:
        'Run a job (id or alias) once, right now, even if it is disabled -- it is NOT enabled and its schedule is not changed (an enabled job keeps running on its normal schedule). The overlap policy still applies (with overlap=skip and a run already active, the run is recorded as skipped). This executes the job\'s prompt on the user\'s machine right now -- confirm with the user before calling. Returns a runId to track progress with crontick_run_get.',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or alias') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.runNow(args.id)),
  );

  server.registerTool(
    'crontick_job_trigger',
    {
      description:
        'Fire a webhook-kind job (id or alias) once, right now, with an optional JSON payload delivered to the run as untrusted event data (CRONTICK_EVENT). Same path as relay events but local: no signature/dedupe/burst checks. Non-webhook jobs are refused with NOT_WEBHOOK_JOB (use crontick_job_run_now); disabled jobs with JOB_DISABLED. This executes the job\'s prompt on the user\'s machine -- confirm with the user before calling. Returns a runId to track progress with crontick_run_get.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or alias of a webhook job'),
        payload: z.unknown().optional().describe('Event payload: any JSON value'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.triggerJob(args.id, { payload: args.payload })),
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
      description: 'List recent runs, optionally filtered by job (id or alias) and/or status. Status includes the terminal "missed" state for schedule fires that were recorded but never executed because the daemon was down.',
      inputSchema: withVerbose({
        jobId: z.string().describe('Job id (GUID) or alias').optional(),
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
      description:
        'Get run details and status, including Claude cost, turns, redacted usage, transcript path, engine status, the Runner Session ID (sessionId), logFile (absolute path of the per-job file of crontick-side events; the engine\'s own transcript is kept by the runner, see transcriptPath), and the cleaned output: the engine\'s final answer (result), any error, and the full engine stderr.',
      inputSchema: withVerbose({ id: z.string().describe('Run id') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, async (client) => {
      const run = await client.getRun(args.id);
      return { ...run, output: await client.getOutput(args.id) };
    }),
  );

  server.registerTool(
    'crontick_run_delete',
    {
      description:
        'Permanently delete run history (and each run\'s stored output) either by run ids (runIds) or all runs of one job (job: id or alias). Active (queued/running) runs are skipped and listed under skipped; unknown ids are listed under notFound. This cannot be undone -- confirm with the user first, and consider calling with dryRun:true to preview exactly what would be deleted. Returns { deleted, skipped, notFound, jobLogRemoved }.',
      inputSchema: withVerbose({
        runIds: z.array(z.string()).min(1).optional().describe('Run ids to delete. Provide this or job, not both.'),
        job: z.string().optional().describe('Job id (GUID) or alias whose runs are all deleted'),
        dryRun: z.boolean().optional().describe('Preview only: report what would be deleted without deleting anything.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.deleteRuns(withoutVerbose(args))),
  );

  server.registerTool(
    'crontick_job_schedule',
    {
      description:
        'Show the next N upcoming fire times for an existing job (id or alias). Useful to confirm a job\'s schedule is what the user expects.',
      inputSchema: withVerbose({
        id: z.string().describe('Job id (GUID) or alias'),
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
      description: 'Get run counts, last status, total engine cost in USD, and total turns for one job (id or alias).',
      inputSchema: withVerbose({ id: z.string().describe('Job id (GUID) or alias') }),
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


  server.registerTool(
    'crontick_daemon_pause',
    {
      description:
        'Pause scheduling: the daemon (HTTP API + dashboard) stays up but starts no new runs. Fires that come due while paused are not run and not replayed; each is recorded as a run with status skipped. In-flight runs continue. Paused state is not persisted: a daemon restart comes up unpaused. Undo with crontick_daemon_resume.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonPause()),
  );

  server.registerTool(
    'crontick_daemon_resume',
    {
      description: 'Resume scheduling after crontick_daemon_pause. Fires skipped while paused are not replayed.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.daemonResume()),
  );

  // ── Config ─────────────────────────────────────────────────────────────────

  const IN_FLIGHT_INPUT = z.enum(['stop', 'wait']).optional().describe(
    'Only needed when runs are in flight (the call then fails with RUNS_IN_FLIGHT listing them): "stop" cancels them then applies; "wait" pauses the daemon, waits for them to finish, applies, then resumes. Ask the user which before choosing.',
  );

  server.registerTool(
    'crontick_config_list',
    {
      description:
        'Return the effective crontick config (defaults merged with the config file; secrets redacted) plus the keys stored in the file (stored), the file revision, and read-only keys. Works with the daemon down.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, async (client) => client.configList(), false),
  );

  server.registerTool(
    'crontick_config_get',
    {
      description: 'Return one effective config value by dotted key (e.g. defaults.timeoutSec, engines.claude.command). Secrets are redacted. Unknown key fails with CONFIG_KEY_NOT_FOUND.',
      inputSchema: withVerbose({ key: z.string().describe('Dotted config key') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, async (client) => ({ key: args.key, value: client.configGet(args.key) }), false),
  );

  server.registerTool(
    'crontick_config_set',
    {
      description:
        'Set one config value by dotted key. value is typed JSON (number, boolean, string, array, object), not parsed text. Engines: key engines.<name> with an object value such as {"command":"...","type":"raw"}. The change is validated and written atomically, then the running daemon is reloaded; the result lists changed keys, reload status, warnings and a notice. daemon.* keys are rejected while a daemon is running. This changes how future jobs run (including which commands engines execute) -- confirm with the user before calling.',
      inputSchema: withVerbose({
        key: z.string().describe('Dotted config key'),
        value: z.any().describe('New value, as typed JSON'),
        inFlight: IN_FLIGHT_INPUT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.configSet(args.key, args.value, { inFlight: args.inFlight }), false),
  );

  server.registerTool(
    'crontick_config_unset',
    {
      description:
        'Remove one config key from the config file so it reverts to its default (engines: key engines.<name> removes that engine). Validated and written atomically, then the running daemon is reloaded; the result lists changed keys, reload status, warnings and a notice. Removing the default engine or the last engine is rejected.',
      inputSchema: withVerbose({
        key: z.string().describe('Dotted config key'),
        inFlight: IN_FLIGHT_INPUT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.configUnset(args.key, { inFlight: args.inFlight }), false),
  );

  // ── Admin ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_export',
    {
      description:
        'Export job definitions as a crontick export file ({ schema: 1, exportedAt, crontickVersion, jobs }). Jobs only: no run history, and job ids are omitted (importing assigns new ids). Use this to back up or migrate jobs. Set onlyJobs (ids or aliases) to export a subset; an unknown entry fails the whole export with JOB_NOT_FOUND.',
      inputSchema: withVerbose({
        onlyJobs: z.array(z.string()).optional().describe('Ids or aliases of the jobs to export (default: all jobs)'),
        includeSecrets: z.boolean().optional().describe('Keep webhook relay URLs and secrets in the export (default: stripped). They are bearer secrets and will appear in this tool result.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.exportJobs({ onlyJobs: args.onlyJobs, includeSecrets: args.includeSecrets }), shouldStartDaemon(), args.includeSecrets !== true),
  );

  server.registerTool(
    'crontick_import',
    {
      description:
        'Import jobs from a crontick export file (pass the object returned by crontick_export: schema 1 plus jobs). The whole file is validated first and a bad file imports nothing. Every job gets a new id; an alias already in use is renamed with a -2, -3, ... suffix (reported as renamedFrom); existing jobs are never overwritten and run history is never imported. Each import persists recurring jobs that execute AI prompts on the user\'s machine -- confirm the imported job definitions with the user before calling. Claude jobs in a folder Claude does not trust yet fail with TRUST_REQUIRED: ask the user, then call again with trustFolder: true.',
      inputSchema: withVerbose({
        schema: z.number().describe('Export format version; must be 1'),
        jobs: z.array(z.unknown()),
        exportedAt: z.string().optional(),
        crontickVersion: z.string().optional(),
        trustFolder: TRUST_FOLDER_INPUT,
        includeSecrets: z.boolean().optional().describe('Keep webhook relay URLs and secrets from the file (default: stripped on import)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const { trustFolder, includeSecrets, verbose: _verbose, ...file } = args;
      void _verbose;
      return toolWrap(args, (client) => client.importJobs(file, { trustFolder, includeSecrets }));
    },
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

  // Status only: enable/disable are a deliberate MCP exemption (agents must not create login persistence).
  server.registerTool(
    'crontick_autostart_status',
    {
      description:
        'Report whether crontick is registered to start at login (read-only): supported, enabled, mechanism, definition path, registered command, stale flag with reasons, and hints. This tool cannot enable or disable autostart; the user does that with `crontick autostart enable|disable`.',
      inputSchema: withVerbose({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolWrap(args, (client) => client.autostartStatus(), false),
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
