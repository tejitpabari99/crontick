/**
 * CLI shim — thin adapter over CrontickClient via Commander v12.
 * Translates flags/positionals into client method calls, formats output to
 * stdout (JSON or tabular), and prints errors to stderr with exit code 1.
 * Contains no business logic; all scheduling, persistence, and validation live
 * in the client and daemon.
 */
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { CrontickError } from '../errors.js';
import { createClient, type CrontickClient } from '../client.js';
import { buildJobPatchFromUpdateOptions, type JobCreateCliOptions, type JobPatchCliOptions } from '../job-input.js';
import type { Schedule } from '../schemas/job.js';
import type { EngineConfig } from '../schemas/config.js';
import { isVerboseEnv, type LogEvent } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function daemonScript(): string {
  return resolve(__dirname, '../daemon/index.js');
}

function mcpScript(): string {
  return resolve(__dirname, '../mcp/index.js');
}

/** Factory: startDaemon=true (default) demand-starts the daemon on first use. */
function client(startDaemon = true) {
  const verbose = useVerbose();
  return createClient({
    daemonScript: daemonScript(),
    startDaemon,
    mcpScript: mcpScript(),
    cwd: process.cwd(),
    verbose,
    onLog: verbose ? renderLogEvent : undefined,
  });
}

function useJson(): boolean {
  return !!(program.opts() as { json?: boolean }).json;
}

/** Also enabled by CRONTICK_VERBOSE=1 so verbose diagnostics work in scripts. */
function useVerbose(): boolean {
  return !!(program.opts() as { verbose?: boolean }).verbose || isVerboseEnv();
}

function stdout(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function stderr(line = ''): void {
  process.stderr.write(`${line}\n`);
}

function renderLogEvent(event: LogEvent): void {
  const data = event.data === undefined ? '' : ` ${JSON.stringify(event.data)}`;
  stderr(`[crontick:${event.level}] ${event.component ? `${event.component} ` : ''}${event.message}${data}`);
}

/** Render output: --json emits JSON; otherwise tabular for arrays, key:value for objects. */
function print(data: unknown, json = useJson()): void {
  if (json) {
    stdout(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      stdout('(no items)');
      return;
    }
    const rows = data as Array<Record<string, unknown>>;
    const keys = Object.keys(rows[0]);
    stdout(keys.join('\t'));
    for (const row of rows) {
      stdout(keys.map((key) => display(row[key])).join('\t'));
    }
    return;
  }
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      stdout(`${key}: ${display(value)}`);
    }
    return;
  }
  stdout(String(data ?? ''));
}

function printNotices(c: CrontickClient, notices: string[] = []): void {
  const all = [...notices, ...c.drainNotices()];
  for (const notice of all) stderr(`Notice: ${notice}`);
}

function display(value: unknown): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

function errorPayload(err: unknown): { code?: string; message: string; details?: unknown } {
  if (err instanceof CrontickError) return err.toJSON();
  if (err instanceof Error) {
    const payload: { code?: string; message: string; details?: unknown } = { message: err.message };
    if ('code' in err && typeof err.code === 'string') payload.code = err.code;
    if ('details' in err) payload.details = err.details;
    return payload;
  }
  if (err && typeof err === 'object') {
    const record = err as { code?: unknown; message?: unknown; details?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : String(err),
      details: record.details,
    };
  }
  return { message: String(err) };
}

function formatErrorDetails(details: unknown, path: string[] = []): string[] {
  if (details === undefined || details === null) return [];
  if (Array.isArray(details)) {
    const rendered = details.flatMap((value) => formatErrorDetails(value, path));
    return rendered.length > 0 ? rendered : [path.length > 0 ? `${path.join('.')}: ${JSON.stringify(details)}` : JSON.stringify(details)];
  }
  if (typeof details === 'object') {
    const record = details as Record<string, unknown>;
    const messages = Array.isArray(record._errors)
      ? record._errors.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    const lines = path.length > 0
      ? messages.map((message) => `${path.join('.')}: ${message}`)
      : [...messages];
    for (const [key, value] of Object.entries(record)) {
      if (key === '_errors') continue;
      lines.push(...formatErrorDetails(value, [...path, key]));
    }
    if (lines.length > 0) return lines;
    return [path.length > 0 ? `${path.join('.')}: ${JSON.stringify(details)}` : JSON.stringify(details)];
  }
  return [path.length > 0 ? `${path.join('.')}: ${String(details)}` : String(details)];
}

function openDashboardUrl(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function printDashboardData(data: unknown): void {
  const model = data as {
    stats?: { totalJobs?: number; enabledJobs?: number; totalRuns?: number; failed?: number };
    jobs?: Array<{ id: string; enabled: boolean; scheduleLabel: string; actionKind: string; lastStatus?: string | null }>;
    runs?: Array<{ id: string; jobId: string; status: string; startedAt: number }>;
  };
  const stats = model.stats;
  if (stats) {
    stdout(`Jobs: ${stats.enabledJobs ?? 0}/${stats.totalJobs ?? 0} enabled`);
    stdout(`Runs: ${stats.totalRuns ?? 0} total, ${stats.failed ?? 0} failed`);
  }
  stdout('');
  stdout('Jobs');
  if (!model.jobs || model.jobs.length === 0) stdout('(no jobs)');
  else {
    for (const job of model.jobs) {
      stdout(`- ${job.id} [${job.enabled ? 'enabled' : 'disabled'}] ${job.actionKind} ${job.scheduleLabel} last=${job.lastStatus ?? '—'}`);
    }
  }
  stdout('');
  stdout('Recent runs');
  if (!model.runs || model.runs.length === 0) stdout('(no runs)');
  else {
    for (const run of model.runs) {
      stdout(`- ${run.id} ${run.jobId} ${run.status} ${new Date(run.startedAt).toISOString()}`);
    }
  }
}

/**
 * Map any error to stderr + a non-zero exit code. CrontickError includes a
 * machine-readable code.
 *
 * Deliberately sets `process.exitCode` instead of calling `process.exit()`.
 * Daemon-backed errors arrive after an in-flight `fetch()` (undici) request;
 * calling `process.exit()` immediately can race the socket/handle teardown
 * that fetch schedules for after the response body is read, which trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in libuv on
 * Windows. Setting `exitCode` and returning lets Node drain the event loop
 * (finishing that teardown) before exiting on its own with the same code.
 */
function handleError(err: unknown): void {
  const payload = errorPayload(err);
  if (useJson()) {
    stderr(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  if (payload.code) {
    stderr(`Error [${payload.code}]: ${payload.message}`);
  } else {
    stderr(`Error: ${payload.message}`);
  }

  const detailLines = formatErrorDetails(payload.details);
  if (detailLines.length > 0) {
    stderr('Details:');
    for (const line of detailLines) stderr(`- ${line}`);
  }

  process.exitCode = 1;
}

function assertDaemonStartJsonMode(foreground: boolean): void {
  if (!foreground || !useJson()) return;
  throw new CrontickError(
    'VALIDATION_ERROR',
    'Cannot combine --foreground with --json for `crontick daemon start`: foreground mode streams daemon logs to stdout and cannot emit a single JSON object.',
  );
}

function commonJobOptions(command: Command): Command {
  return command
    .option('--cron <expr>', 'Cron expression (e.g. "0 9 * * *")')
    .option('--every <sec>', 'Interval in seconds', parseInteger)
    .option('--at <iso>', 'One-shot run-at ISO-8601 time')
    .option('--tz <tz>', 'Timezone for cron schedule')
    .option('--script <body>', 'Inline script body')
    .option('--exec <cmd>', 'Command to exec, taken verbatim (no whitespace splitting). Pass arguments with repeatable --arg <value> (always correct on every shell/shim, including Windows crontick.cmd/.ps1) — e.g. --exec node --arg -e --arg "process.stdout.write(1)". As a convenience (not guaranteed on every shim), args may instead follow -- (e.g. --exec node -- -e "process.stdout.write(1)"); --arg and -- cannot be combined')
    .option('--prompt <text>', 'Prompt text for a prompt action')
    .option('--prompt-file <path>', 'UTF-8 .txt file to read into the prompt')
    .option('--arg <value>', 'Argument to pass to --exec or --prompt; repeatable (e.g. --arg -e --arg "a b"). Always safe: works identically on every shell and every Windows shim (crontick.cmd, crontick.ps1, npx), and round-trips spaces, quotes, and leading dashes verbatim. This is the documented way to pass arguments; cannot be combined with -- positional args in the same command.', collectOption)
    .option('--engine <engine>', 'Configured prompt engine name (default: config defaultEngine)')
    .option('--session-id <id>', 'Reuse this prompt engine session every run')
    .option('--reuse-session', 'Capture the first successful run session id and reuse it')
    .option('--file <path>', 'Load job JSON from a file')
    // No hardcoded default here (unlike most flags): a Commander default would
    // be indistinguishable from the user explicitly typing the same value,
    // which on `update` previously caused an omitted flag to silently reset
    // a customized shell/overlap policy back to the default. Leaving it
    // undefined when omitted lets job-input.ts tell "not specified" apart
    // from "explicitly set to the default value" on both `new` and `update`.
    // `new` still defaults to auto/skip explicitly in job-input.ts.
    .option('--shell <shell>', 'Shell: auto|bash|pwsh|cmd (default on create: auto; omit on update to leave unchanged)')
    .option('--job-env-file <path>', 'Load extra environment variables from a .env file')
    .option('--timeout <sec>', 'Timeout in seconds', parseInteger)
    .option('--overlap <policy>', 'Overlap policy: skip|queue|cancel-previous (default on create: skip; omit on update to leave unchanged)')
    .option('--retry <max>', 'Retry count', parseInteger)
    .option('--desc <description>', 'Job description');
}

function collectJobOptions(id: string, engineArgs: string[], opts: Record<string, unknown>): JobCreateCliOptions {
  return {
    id,
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    args: stringArrayOption(opts.arg),
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    tz: stringOption(opts.tz),
    script: stringOption(opts.script),
    exec: stringOption(opts.exec),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.engine),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
    shell: stringOption(opts.shell),
    envFile: stringOption(opts.jobEnvFile),
    timeout: numberOption(opts.timeout),
    overlap: stringOption(opts.overlap),
    retry: numberOption(opts.retry),
    desc: stringOption(opts.desc),
    force: booleanOption(opts.force),
  };
}

function collectPatchOptions(engineArgs: string[], opts: Record<string, unknown>): JobPatchCliOptions {
  if (opts.enable && opts.disable) throw new CrontickError('VALIDATION_ERROR', '--enable and --disable are mutually exclusive');
  return {
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    args: stringArrayOption(opts.arg),
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    tz: stringOption(opts.tz),
    script: stringOption(opts.script),
    exec: stringOption(opts.exec),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.engine),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
    shell: stringOption(opts.shell),
    envFile: stringOption(opts.jobEnvFile),
    timeout: numberOption(opts.timeout),
    overlap: stringOption(opts.overlap),
    retry: numberOption(opts.retry),
    desc: stringOption(opts.desc),
    enabled: opts.enable ? true : opts.disable ? false : undefined,
  };
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError(`Invalid integer: ${value}`);
  return parsed;
}

class InvalidArgumentError extends Error {}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanOption(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayOption(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}

function parseScheduleJson(raw: string): Schedule {
  return JSON.parse(raw) as Schedule;
}

/** Attempt JSON parse; fall back to raw string for bare values like `true` or `hello`. */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Commander repeatable option accumulator (e.g. --arg a --arg b → ['a','b']). */
function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * Guards against the case where a user places a crontick flag (e.g. --json)
 * after `--`, expecting it to still be parsed as a crontick option. Commander
 * treats everything after a literal `--` as positional (this is standard,
 * documented `--` semantics), so such a token instead becomes a literal
 * argument to the job's exec/prompt action — silently corrupting the job
 * instead of doing what the user meant.
 *
 * Only long-form flags (`--foo`) registered on this command or the top-level
 * program are checked; short flags (`-v`, `-e`, ...) are common, legitimate
 * literal arguments to arbitrary commands (e.g. `node -e`) and are not
 * flagged. Anyone who genuinely needs to pass a literal value that happens to
 * match a crontick flag name should use `--arg` instead, which is never
 * inspected for collisions.
 */
function assertNoCrontickFlagCollision(rawArgs: string[], cmd: Command): void {
  const known = new Set<string>();
  for (const opt of [...program.options, ...cmd.options]) {
    if (opt.long) known.add(opt.long);
  }
  const collisions = rawArgs.filter((token) => known.has(token));
  if (collisions.length === 0) return;
  throw new CrontickError(
    'VALIDATION_ERROR',
    `Argument(s) ${collisions.join(', ')} placed after -- match a crontick flag name and were NOT applied as crontick options -- ` +
      'this would otherwise silently store them as literal job arguments. Move crontick flags before the -- delimiter, or, ' +
      `if you meant them literally, pass them with --arg (e.g. --arg "${collisions[0]}") which is never treated as a crontick flag.`,
  );
}

/**
 * Commander's root `program` recognizes `--json`, `-v`/`--verbose`,
 * `-h`/`--help`, and `-V`/`--version` ANYWHERE in argv, not just before the
 * subcommand name (verified empirically: `program.parseOptions()` flat-scans
 * the whole array unless `enablePositionalOptions`/`passThroughOptions` is
 * set, which this CLI intentionally does not do, since every subcommand
 * relies on being able to place --json/--verbose at the end of the command).
 * That means `--arg -v` or `--arg --json` (two separate argv tokens) gets
 * silently intercepted by the ROOT program as its own global flag before the
 * `new`/`update`/`engine` subcommand ever sees "-v"/"--json" as `--arg`'s
 * value — exactly the kind of silent corruption `--arg` exists to prevent.
 * `--arg=-v` (a single combined token) does not collide, because Commander's
 * exact-match root scan only matches whole tokens. Rewriting the vulnerable
 * two-token form into the equivalent single `--arg=<value>` token here, before
 * Commander ever sees argv, makes `--arg`'s round-trip guarantee hold for
 * every value with no user-visible difference and no change to Commander's
 * global option-parsing behavior elsewhere.
 */
const ARG_COLLISION_RISK_TOKENS = new Set(['--json', '-v', '--verbose', '-h', '--help', '-V', '--version']);

function rewriteArgValuesCollidingWithGlobalFlags(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      // Everything after a literal -- is already immune (Commander stops its
      // own global-flag scan there too) and is the user's own positional
      // data, not a `--arg` occurrence of ours — leave it untouched.
      result.push(...argv.slice(i));
      break;
    }
    const next = argv[i + 1];
    if (token === '--arg' && next !== undefined && ARG_COLLISION_RISK_TOKENS.has(next)) {
      result.push(`--arg=${next}`);
      i++; // consumed as part of the merged token above
      continue;
    }
    result.push(token);
  }
  return result;
}

function parseEnvEntries(entries: string[] | undefined): Record<string, string> | undefined {
  if (entries === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new CrontickError('VALIDATION_ERROR', `Invalid --env value "${entry}". Use KEY=VALUE.`);
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

function engineConfigFromOptions(opts: Record<string, unknown>, partial: boolean): EngineConfig | Partial<EngineConfig> {
  const command = stringOption(opts.command);
  const args = Array.isArray(opts.arg) ? opts.arg.filter((value): value is string => typeof value === 'string') : undefined;
  const env = parseEnvEntries(Array.isArray(opts.env) ? opts.env.filter((value): value is string => typeof value === 'string') : undefined);
  if (!partial && !command) {
    throw new CrontickError('VALIDATION_ERROR', 'Provide --command <cmd> when adding an engine.');
  }
  const engine: Partial<EngineConfig> = {};
  if (command !== undefined) engine.command = command;
  if (args !== undefined) engine.args = args;
  if (env !== undefined) engine.env = env;
  return engine as EngineConfig | Partial<EngineConfig>;
}

const program = new Command();

program
  .name('crontick')
  .description('A standalone cron daemon, CLI, and MCP server for local scheduled jobs.')
  .version(VERSION)
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Write crontick diagnostic logs to stderr (also enabled by CRONTICK_VERBOSE=1)');

commonJobOptions(program.command('new <id> [engineArgs...]').description('Create a new job'))
  .option('--force', 'Replace an existing job when the same id already exists')
  .action(async (id: string, engineArgs: string[], opts, cmd: Command) => {
    const c = client();
    try {
      assertNoCrontickFlagCollision(engineArgs, cmd);
      const result = await c.createJobFromCliOptions(collectJobOptions(id, engineArgs, opts));
      printNotices(c);
      print(result);
    } catch (err) {
      handleError(err);
    }
  });

commonJobOptions(program.command('update <id> [engineArgs...]').description('Update an existing job'))
  .option('--enable', 'Enable the job')
  .option('--disable', 'Disable the job')
  .action(async (id: string, engineArgs: string[], opts, cmd: Command) => {
    const c = client();
    const notices: string[] = [];
    try {
      assertNoCrontickFlagCollision(engineArgs, cmd);
      const patch = buildJobPatchFromUpdateOptions(collectPatchOptions(engineArgs, opts), {
        cwd: process.cwd(),
        onNotice: (message) => notices.push(message),
      });
      const result = await c.updateJob(id, patch);
      printNotices(c, notices);
      print(result);
    } catch (err) {
      handleError(err);
    }
  });

program.command('list').description('List all jobs').action(async () => {
  try { print(await client().listJobs()); } catch (err) { handleError(err); }
});

program.command('get <id>').description('Get a job by ID').action(async (id: string) => {
  try { print(await client().getJob(id)); } catch (err) { handleError(err); }
});

program.command('enable <id>').description('Enable a job').action(async (id: string) => {
  try { print(await client().enableJob(id)); } catch (err) { handleError(err); }
});

program.command('disable <id>').description('Disable a job').action(async (id: string) => {
  try { print(await client().disableJob(id)); } catch (err) { handleError(err); }
});

program.command('delete <id>').description('Delete a job definition; archived runs remain queryable by run ID').action(async (id: string) => {
  try { print(await client().deleteJob(id)); } catch (err) { handleError(err); }
});

program.command('run-now <id>').description('Trigger an immediate run of a job').action(async (id: string) => {
  try { print(await client().runNow(id)); } catch (err) { handleError(err); }
});

program.command('cancel-run <runId>').description('Cancel an in-progress run').action(async (runId: string) => {
  try { print(await client().cancelRun(runId)); } catch (err) { handleError(err); }
});

const RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'canceled', 'timeout', 'missed'] as const;

const runs = program.command('runs').description('Inspect run history');
runs.command('list')
  .description('List recent runs')
  .option('--job <id>', 'Filter by job ID')
  .option('--limit <n>', 'Maximum runs to return', parseInteger)
  .option('--since <ms>', 'Only runs since epoch milliseconds', parseInteger)
  .option('--status <status>', `Filter by run status (${RUN_STATUSES.join('|')})`)
  .action(async (opts) => {
    try {
      print(await client().listRuns({
        jobId: opts.job as string | undefined,
        limit: opts.limit as number | undefined,
        since: opts.since as number | undefined,
        status: opts.status as string | undefined,
      }));
    } catch (err) { handleError(err); }
  });
runs.command('get <runId>').description('Get a run by ID').action(async (runId: string) => {
  try { print(await client().getRun(runId)); } catch (err) { handleError(err); }
});

program.command('logs <runId>')
  .description('Get logs for a run')
  .option('--tail <n>', 'Show last N lines', parseInteger)
  .action(async (runId: string, opts) => {
    try {
      const result = await client().getLogs(runId, { lines: opts.tail as number | undefined });
      if (useJson()) {
        stdout(JSON.stringify(result, null, 2));
      } else {
        for (const entry of result.lines) process.stdout.write(`[${entry.stream}] ${entry.data}`);
      }
    } catch (err) { handleError(err); }
  });

const schedule = program.command('schedule').description('Validate and preview schedules');
schedule.command('validate <scheduleJson>').description('Validate a schedule JSON object').action(async (scheduleJson: string) => {
  try { print(await client().validateSchedule(parseScheduleJson(scheduleJson))); } catch (err) { handleError(err); }
});
schedule.command('preview <scheduleJson>')
  .description('Preview upcoming fire times for a schedule JSON object')
  .option('--limit <n>', 'Number of fire times to return', parseInteger)
  .option('--tz <tz>', 'Timezone override')
  .action(async (scheduleJson: string, opts) => {
    try { print(await client().previewSchedule({ schedule: parseScheduleJson(scheduleJson), n: opts.limit as number | undefined, tz: opts.tz as string | undefined })); } catch (err) { handleError(err); }
  });

const stats = program.command('stats').description('Show job/run statistics');
stats.command('summary').description('Show aggregate statistics').action(async () => {
  try { print(await client().statsSummary()); } catch (err) { handleError(err); }
});
stats.command('job <id>').description('Show statistics for one job').action(async (id: string) => {
  try { print(await client().statsJob(id)); } catch (err) { handleError(err); }
});

// Config commands pass startDaemon=false — they operate on the local config file
// without needing the daemon running.
const config = program.command('config').description('Inspect and edit crontick config');
config.command('get [path]').description('Get the effective config or one config value').action((path?: string) => {
  try { print(client(false).getConfigValue(path)); } catch (err) { handleError(err); }
});
config.command('set <path> <value>').description('Set one config value; value is JSON when possible').action((path: string, value: string) => {
  try { print(client(false).setConfigValue(path, parseJsonValue(value))); } catch (err) { handleError(err); }
});
config.command('unset <path>').description('Remove one config value').action((path: string) => {
  try { print(client(false).removeConfigValue(path)); } catch (err) { handleError(err); }
});
config.command('init').description('Create the default config file')
  .option('--force', 'Replace an existing config file')
  .action((opts) => {
    try { print(client(false).initConfig({ force: opts.force as boolean | undefined })); } catch (err) { handleError(err); }
  });
config.command('validate [path]').description('Validate the config file').action((path?: string) => {
  try {
    const result = client(false).validateConfig(path);
    print(result);
    if (!result.ok) process.exit(1); // non-zero exit for CI/script usage
  } catch (err) { handleError(err); }
});

const configEngines = config.command('engines').description('List and edit configured engines');
configEngines.action(() => {
  try { print(client(false).listEngines()); } catch (err) { handleError(err); }
});
configEngines.command('add <name>').description('Add an engine')
  .requiredOption('--command <cmd>', 'Engine executable')
  .option('--arg <arg>', 'Default engine argument; repeatable', collectOption)
  .option('--env <KEY=VALUE>', 'Default engine environment variable; repeatable', collectOption)
  .action((name: string, opts) => {
    try { print(client(false).addEngine(name, engineConfigFromOptions(opts, false) as EngineConfig)); } catch (err) { handleError(err); }
  });
configEngines.command('update <name>').description('Update an engine')
  .option('--command <cmd>', 'Engine executable')
  .option('--arg <arg>', 'Default engine argument; repeatable. Replaces the current args when provided.', collectOption)
  .option('--env <KEY=VALUE>', 'Default engine environment variable; repeatable. Replaces current env when provided.', collectOption)
  .action((name: string, opts) => {
    try { print(client(false).updateEngine(name, engineConfigFromOptions(opts, true) as Partial<EngineConfig>)); } catch (err) { handleError(err); }
  });
configEngines.command('remove <name>').description('Remove an engine').action((name: string) => {
  try { print(client(false).removeEngine(name)); } catch (err) { handleError(err); }
});

program.command('export')
  .description('Export all jobs')
  .option('--out <file>', 'Output file (default: stdout)')
  .option('--include-runs', 'Also include run history in the export')
  .action(async (opts) => {
    try {
      const data = await client().exportJobs({ includeRuns: opts.includeRuns as boolean | undefined });
      const json = JSON.stringify(data, null, 2);
      if (opts.out) {
        writeFileSync(resolve(process.cwd(), opts.out as string), json, 'utf-8');
        stdout(`Exported to ${opts.out as string}`);
      } else {
        stdout(json);
      }
    } catch (err) { handleError(err); }
  });

program.command('import <file>').description('Import jobs (and run history, if present) from a JSON file').action(async (file: string) => {
  try {
    const filePath = resolve(process.cwd(), file);
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as { jobs?: unknown[]; runs?: unknown[] } | unknown[];
    const jobs = Array.isArray(data) ? data : data.jobs;
    const runs = Array.isArray(data) ? undefined : data.runs;
    print(await client().importJobs(Array.isArray(jobs) ? jobs : [], { fileBaseDir: dirname(filePath), runs }));
  } catch (err) { handleError(err); }
});

program.command('doctor').description('Check system health').action(async () => {
  try {
    const result = await client(false).doctor({ mcpScript: mcpScript() });
    if (useJson()) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        stdout(`${check.ok ? '✓' : '✗'} ${check.name}${check.note ? ` (${check.note})` : ''}`);
      }
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) { handleError(err); }
});

const daemon = program.command('daemon').description('Manage the crontick daemon');
daemon.command('start')
  .description('Start the daemon')
  .option('--foreground', 'Run in foreground (blocking)')
  .action(async (opts) => {
    try {
      const foreground = opts.foreground === true;
      assertDaemonStartJsonMode(foreground);
      const result = await client().daemonStart({ foreground });
      if (foreground) process.exit(result.foregroundExitCode ?? 0);
      if (useJson()) print(result);
      else stdout(result.started ? `Daemon started on port ${String(result.port ?? '')}` : `Daemon already running on port ${String(result.port ?? '')}`);
    } catch (err) { handleError(err); }
  });
daemon.command('stop').description('Stop the daemon').action(async () => {
  try {
    const result = await client(false).daemonStop();
    if (useJson()) print(result);
    else stdout(`${result.message} (mode: ${result.mode})`);
  } catch (err) { handleError(err); }
});
daemon.command('status').description('Show daemon status').action(async () => {
  try { print(await client(false).daemonStatus()); } catch { stdout('Daemon is not running'); }
});
daemon.command('reload').description('Reload jobs from disk').action(async () => {
  try { print(await client().daemonReload()); } catch (err) { handleError(err); }
});
daemon.command('restart').description('Restart the daemon').action(async () => {
  try {
    const result = await client().daemonRestart();
    if (useJson()) print(result);
    else stdout(`Daemon restarted on port ${String(result.port ?? '')}`);
  } catch (err) { handleError(err); }
});

const dashboard = program.command('dashboard').description('Manage the crontick dashboard');
dashboard.command('start')
  .description('Start the dashboard server')
  .option('--open', 'Open in the default browser')
  .action(async (opts) => {
    try {
      const result = await client().dashboardStart();
      if (opts.open as boolean) openDashboardUrl(result.url);
      if (useJson()) print(result, true);
      else stdout(`Dashboard ${opts.open ? 'opened' : 'running'}: ${result.url}`);
    } catch (err) { handleError(err); }
  });
dashboard.command('status').description('Show dashboard status').action(async () => {
  try {
    const result = await client(false).dashboardStatus();
    if (useJson()) print(result, true);
    else stdout(`Dashboard ${result.running ? 'running' : 'stopped'}: ${result.url}`);
  } catch (err) { handleError(err); }
});
dashboard.command('data')
  .description('Return the dashboard data model')
  .option('--job <id>', 'Filter runs by job ID')
  .option('--runs-limit <n>', 'Maximum recent runs to return', parseInteger)
  .action(async (opts) => {
    try {
      const result = await client(false).dashboardData({
        jobId: opts.job as string | undefined,
        runsLimit: opts.runsLimit as number | undefined,
      });
      if (useJson()) print(result, true);
      else printDashboardData(result);
    } catch (err) { handleError(err); }
  });
dashboard.command('stop').description('Stop the dashboard server').action(async () => {
  try {
    const result = await client(false).dashboardStop();
    if (useJson()) print(result, true);
    else stdout(result.message);
  } catch (err) { handleError(err); }
});

// The `mcp` subcommand launches the MCP server process directly via spawnSync
// (inheriting stdio for JSON-RPC). It is NOT listed in SURFACE_CAPABILITIES
// because it starts a server rather than proxying a daemon operation.
program.command('mcp')
  .description('Start the crontick MCP server on stdio (for use with Claude Desktop, Copilot, Cursor, etc.)')
  .option('--no-start-daemon', 'Set startDaemon=false for MCP daemon-backed tools')
  .option('--daemon-url <url>', 'Override the daemon URL (default: resolved from port file)')
  .addHelpText('after', `
Transport:    stdio (JSON-RPC 2.0 over stdin/stdout)
Tool prefix:  crontick_
Daemon start: startDaemon defaults to true; use --no-start-daemon or CRONTICK_MCP_START_DAEMON=0 to disable demand-start

Example MCP host config (Claude Desktop):
  {
    "mcpServers": {
      "crontick": { "command": "crontick", "args": ["mcp"] }
    }
  }`)
  .action((opts) => {
    const script = mcpScript();
    if (!existsSync(script)) {
      stderr(`MCP server script not found: ${script}. Run: npm run build`);
      process.exit(1);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.startDaemon === false) env['CRONTICK_MCP_START_DAEMON'] = '0';
    if (opts.daemonUrl) env['CRONTICK_DAEMON_URL'] = opts.daemonUrl as string;
    if (useVerbose()) env['CRONTICK_VERBOSE'] = '1';
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
    process.exit(result.status ?? 0);
  });

program.parse(rewriteArgValuesCollidingWithGlobalFlags(process.argv));
