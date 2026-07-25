/**
 * crontick MCP server — stdio transport.
 * Thin adapter over the local daemon HTTP API.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
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

function shouldStartDaemon(): boolean {
  return process.env['CRONTICK_MCP_START_DAEMON'] !== '0';
}

function mcpScript(): string {
  return pathResolve(__dirname, '../mcp/index.js');
}

type VerboseArgs = { verbose?: boolean };
type RawArgs = Record<string, unknown> & VerboseArgs;

const VERBOSE_INPUT = { verbose: z.boolean().optional() };

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

function withoutVerbose<T extends RawArgs>(args: T): Omit<T, 'verbose'> {
  const rest = { ...args };
  delete rest.verbose;
  return rest;
}

// ── MCP server setup ──────────────────────────────────────────────────────────

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
        'Create and schedule a new cron job. Provide the full job definition including id, schedule (kind: cron|interval|one-shot), and action (kind: script|exec|prompt). Prompt actions use prompt, optional configured engine name, args, sessionId, or reuseSession. Validate the schedule first with crontick_schedule_validate.',
      inputSchema: withVerbose({
...JobCreateInputSchema.shape,
      }),
    },
    async (args) => toolWrap(args, (client) => client.createJob(withoutVerbose(args))),
  );

  server.registerTool(
    'crontick_job_list',
    {
      description: 'List all scheduled jobs with their current status and next run time.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.listJobs()),
  );

  server.registerTool(
    'crontick_job_get',
    {
      description: 'Get the full definition and status of a specific job by ID.',
      inputSchema: withVerbose({ id: z.string() }),
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
    },
    async (args) => toolWrap(args, (client) => client.deleteJob(args.id)),
  );

  server.registerTool(
    'crontick_job_enable',
    {
      description: 'Enable a disabled job so it will run on its next scheduled time.',
      inputSchema: withVerbose({ id: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.enableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_disable',
    {
      description: 'Disable a job so it will not run until re-enabled.',
      inputSchema: withVerbose({ id: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.disableJob(args.id)),
  );

  server.registerTool(
    'crontick_job_run_now',
    {
      description:
        'Trigger an immediate run of a job, bypassing its schedule. Returns a runId to track progress with crontick_run_get.',
      inputSchema: withVerbose({ id: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.runNow(args.id)),
  );

  server.registerTool(
    'crontick_job_cancel_run',
    {
      description: 'Cancel an in-progress run by its run ID.',
      inputSchema: withVerbose({ runId: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.cancelRun(args.runId)),
  );

  // ── Runs ───────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_run_list',
    {
      description: 'List recent runs, optionally filtered by job ID.',
      inputSchema: withVerbose({
        jobId: z.string().optional(),
        limit: z.number().int().positive().optional(),
        since: z.number().int().optional(),
      }),
    },
    async (args) => toolWrap(args, (client) => client.listRuns(withoutVerbose(args))),
  );

  server.registerTool(
    'crontick_run_get',
    {
      description: 'Get the details and current status of a specific run by run ID.',
      inputSchema: withVerbose({ runId: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.getRun(args.runId)),
  );

  server.registerTool(
    'crontick_run_logs_tail',
    {
      description:
        'Get the last N lines of output for a run. Useful for diagnosing failures.',
      inputSchema: withVerbose({
        runId: z.string(),
        lines: z.number().int().positive().default(50),
      }),
    },
    async (args) => toolWrap(args, (client) => client.getLogs(args.runId, { lines: args.lines })),
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
    },
    async (args) => toolWrap(args, (client) => client.statsSummary()),
  );

  server.registerTool(
    'crontick_stats_job',
    {
      description: 'Get run statistics for a specific job: total runs, success/failure rates, last status.',
      inputSchema: withVerbose({ id: z.string() }),
    },
    async (args) => toolWrap(args, (client) => client.statsJob(args.id)),
  );

  // ── Daemon ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_daemon_status',
    {
      description:
        'Get the daemon process status: PID, version, uptime, job counts, run stats, Node version, and platform.',
      inputSchema: withVerbose({}),
    },
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
    },
    async (args) => toolWrap(args, (client) => client.daemonReload()),
  );

  server.registerTool(
    'crontick_daemon_restart',
    {
      description:
        'Restart the crontick daemon (stop + start). Running jobs will be interrupted. Confirm with the user before calling.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.daemonRestart()),
  );

  // ── Admin ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_export',
    {
      description:
        'Export all job definitions as a JSON object. Use this to back up or migrate jobs.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.exportJobs()),
  );

  server.registerTool(
    'crontick_import',
    {
      description:
        'Import job definitions from a JSON array. Jobs are upserted (existing jobs with the same ID are updated).',
      inputSchema: withVerbose({
        jobs: z.array(z.unknown()),
      }),
    },
    async (args) => toolWrap(args, (client) => client.importJobs(args.jobs)),
  );

  server.registerTool(
    'crontick_dashboard_start',
    {
      description:
        'Start the crontick dashboard server and return its URL. The dashboard is served by the local daemon.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.dashboardStart()),
  );

  server.registerTool(
    'crontick_dashboard_status',
    {
      description:
        'Return dashboard server status without starting it. If it is down, start it with crontick_dashboard_start.',
      inputSchema: withVerbose({}),
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
    },
    async (args) => toolWrap(args, (client) => client.dashboardData(withoutVerbose(args)), false),
  );

  server.registerTool(
    'crontick_dashboard_stop',
    {
      description:
        'Stop the daemon-backed dashboard server. This also stops the local daemon because the dashboard is served by it.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.dashboardStop(), false),
  );

  server.registerTool(
    'crontick_doctor',
    {
      description:
        'Run a suite of health checks: Node.js version, SQLite, data directory, daemon connectivity, dashboard reachability, and MCP server availability.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => client.doctor({ mcpScript: mcpScript() }), false),
  );

  // ── Config ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'crontick_config_get',
    {
      description: 'Get the effective crontick config, or a single value by dot-separated path.',
      inputSchema: withVerbose({ path: z.string().optional() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.getConfigValue(args.path)), false),
  );

  server.registerTool(
    'crontick_config_set',
    {
      description: 'Set one crontick config value by dot-separated path. The updated config is validated and returned.',
      inputSchema: withVerbose({ path: z.string(), value: z.unknown() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.setConfigValue(args.path, args.value)), false),
  );

  server.registerTool(
    'crontick_config_unset',
    {
      description: 'Remove one crontick config value by dot-separated path. The updated config is validated and returned.',
      inputSchema: withVerbose({ path: z.string() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.removeConfigValue(args.path)), false),
  );

  server.registerTool(
    'crontick_config_engine_list',
    {
      description: 'List configured prompt engines from the effective crontick config.',
      inputSchema: withVerbose({}),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.listEngines()), false),
  );

  server.registerTool(
    'crontick_config_engine_add',
    {
      description: 'Add a prompt engine. The engine defines the command, default args, and default env used when prompt jobs run.',
      inputSchema: withVerbose({ name: z.string(), engine: EngineConfigSchema }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.addEngine(args.name, args.engine)), false),
  );

  server.registerTool(
    'crontick_config_engine_update',
    {
      description: 'Update a prompt engine. Provided fields replace the existing command, args, or env.',
      inputSchema: withVerbose({ name: z.string(), engine: EngineConfigSchema.partial() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.updateEngine(args.name, args.engine)), false),
  );

  server.registerTool(
    'crontick_config_engine_remove',
    {
      description: 'Remove a prompt engine. You cannot remove the current defaultEngine.',
      inputSchema: withVerbose({ name: z.string() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.removeEngine(args.name)), false),
  );

  server.registerTool(
    'crontick_config_init',
    {
      description: 'Create the default crontick config file. Use force:true to replace an existing file.',
      inputSchema: withVerbose({ force: z.boolean().optional() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.initConfig({ force: args.force })), false),
  );

  server.registerTool(
    'crontick_config_validate',
    {
      description: 'Validate the current crontick config file, or a specific config file path.',
      inputSchema: withVerbose({ path: z.string().optional() }),
    },
    async (args) => toolWrap(args, (client) => Promise.resolve(client.validateConfig(args.path)), false),
  );

  // ── Resources ─────────────────────────────────────────────────────────────

  server.resource(
    'crontick-config-effective',
    'crontick://config/effective',
    { description: 'Effective merged crontick config', mimeType: 'application/json' },
    async () => ({
      contents: [
        {
          uri: 'crontick://config/effective',
          mimeType: 'application/json',
          text: JSON.stringify(mcpClient(false).getConfig(), null, 2),
        },
      ],
    }),
  );

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
        const jobs = await mcpClient().listJobs();
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
              text: JSON.stringify({ error: redactedErrorMessage(err) }, null, 2),
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
        const job = await mcpClient().getJob(String(id ?? ''));
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
              text: JSON.stringify({ error: redactedErrorMessage(err) }, null, 2),
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
        const run = await mcpClient().getRun(String(id ?? ''));
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
              text: JSON.stringify({ error: redactedErrorMessage(err) }, null, 2),
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
        const logs = await mcpClient().getLogs(String(id ?? ''));
        const text = logs.lines.map((line) => `[${line.stream}] ${line.data}`).join('');
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text }],
        };
      } catch (err) {
        return {
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Error: ${redactedErrorMessage(err)}` }],
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
        const run = await mcpClient().getRun(args.runId);
        runInfo = JSON.stringify(run, null, 2);
      } catch (err) {
        runInfo = `Error fetching run: ${redactedErrorMessage(err)}`;
      }

      try {
        const logs = await mcpClient().getLogs(args.runId, { lines: 100 });
        logInfo =
          logs.lines.length > 0
            ? logs.lines.map((line) => `[${line.stream}] ${line.data}`).join('')
            : '(no log output)';
      } catch (err) {
        logInfo = `Error fetching logs: ${redactedErrorMessage(err)}`;
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
