/**
 * CLI shim — thin adapter over CrontickClient via Commander v12.
 * Translates flags/positionals into client method calls, formats output to
 * stdout (JSON or tabular), and prints errors to stderr with exit code 1.
 * Contains no business logic; all scheduling, persistence, and validation live
 * in the client and daemon.
 */
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { CrontickError } from '../errors.js';
import { createClient, type CrontickClient } from '../client.js';
import { buildJobPatchFromUpdateOptions, type JobCreateCliOptions, type JobPatchCliOptions } from '../job-input.js';
import { isVerboseEnv, type LogEvent } from '../logger.js';
import { readJsonFile } from '../json-file.js';

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

/** Also enabled by CRONTICK_VERBOSE=1 so verbose diagnostics work in scripts. */
function useVerbose(): boolean {
  return !!(program.opts() as { verbose?: boolean }).verbose || isVerboseEnv();
}

/** ANSI red for error output; suppressed when NO_COLOR is set or stderr is not a TTY. */
function red(text: string): string {
  const useColor = !process.env.NO_COLOR && process.stderr.isTTY;
  return useColor ? `\x1b[31m${text}\x1b[0m` : text;
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

/** Render output: tabular for arrays, key:value for objects, plain otherwise. */
function print(data: unknown): void {
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

/**
 * Map any error to a single clean, RED line on stderr + a non-zero exit code.
 * No Node stack traces are ever shown; CrontickError codes are surfaced inline.
 * `--verbose` additionally prints structured detail lines for debugging.
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
  const prefix = payload.code ? `error: [${payload.code}] ` : 'error: ';
  stderr(red(`${prefix}${payload.message}`));

  if (useVerbose()) {
    const detailLines = formatErrorDetails(payload.details);
    if (detailLines.length > 0) {
      stderr('Details:');
      for (const line of detailLines) stderr(`- ${line}`);
    }
    if (err instanceof Error && err.stack) stderr(err.stack);
  }

  process.exitCode = 1;
}

/**
 * Top-level handler for errors thrown out of `program.parseAsync` — chiefly
 * Commander usage errors (missing argument, unknown option/command) raised via
 * `exitOverride()`, but also any error an action re-throws. Renders a single
 * clean RED line with no Node stack trace. Help/version display (exitCode 0)
 * is a normal, silent exit.
 */
function handleTopLevelError(err: unknown): void {
  const commander = err as { code?: string; exitCode?: number; message?: string };
  if (commander && typeof commander.code === 'string' && commander.code.startsWith('commander.')) {
    // Help or version output already written to stdout by Commander.
    if (commander.exitCode === 0 || commander.code === 'commander.helpDisplayed'
        || commander.code === 'commander.version' || commander.code === 'commander.help') {
      process.exitCode = 0;
      return;
    }
    const message = (commander.message ?? 'usage error').replace(/^error:\s*/i, '');
    stderr(red(`error: ${message}`));
    process.exitCode = commander.exitCode ?? 1;
    return;
  }
  handleError(err);
}

/** Attach a help-on-invocation action so running a group with no subcommand prints help and exits 0; an unknown subcommand errors cleanly. */
function groupHelp(command: Command): Command {
  command.action(() => {
    if (command.args.length > 0) {
      command.error(`unknown command '${command.args[0]}'`);
    }
    command.outputHelp();
  });
  return command;
}

function commonJobOptions(command: Command): Command {
  return command
    .option('--desc <description>', 'Job description')
    .option('--cron <expr>', 'Cron expression (e.g. "0 9 * * *")')
    .option('--every <sec>', 'Interval in seconds', parseInteger)
    .option('--at <iso>', 'One-shot run-at ISO-8601 time')
    .option('--tz <tz>', 'Timezone for cron schedule')
    .option('--prompt <text>', 'Prompt text for a prompt action')
    .option('--prompt-file <path>', 'UTF-8 .txt file to read into the prompt')
    .option('--engine <engine>', 'Configured prompt engine name (default: config defaultEngine, i.e. copilot)')
    .option('--session-id <id>', 'Reuse this prompt engine session every run')
    .option('--reuse-session', 'Capture the first successful run session id and reuse it')
    .option('--file <path>', 'Create the job from a full job-definition JSON file (advanced; supports all action kinds including script/exec)')
    .option('--alias <alias>', 'Human-friendly, unique, kebab-case job identifier; auto-generated on create when omitted')
    // No hardcoded default here (unlike most flags): a Commander default would
    // be indistinguishable from the user explicitly typing the same value,
    // which on `update` previously caused an omitted flag to silently reset
    // a customized overlap policy back to the default. Leaving it undefined
    // when omitted lets job-input.ts tell "not specified" apart from
    // "explicitly set to the default value" on both `new` and `update`.
    // `new` still defaults to skip explicitly in job-input.ts.
    .option('--timeout <sec>', 'Per-run timeout in seconds (default: none/unbounded; omit on update to leave unchanged)', parseInteger)
    .option('--overlap <policy>', 'Overlap policy: skip|queue|cancel-previous (default on create: skip; omit on update to leave unchanged)')
    .option('--retry <max>', 'Retry count on failure (default: 0; omit on update to leave unchanged)', parseInteger);
}

function collectJobOptions(engineArgs: string[], opts: Record<string, unknown>): JobCreateCliOptions {
  return {
    alias: stringOption(opts.alias),
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    tz: stringOption(opts.tz),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.engine),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
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
    alias: stringOption(opts.alias),
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    tz: stringOption(opts.tz),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.engine),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
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

/**
 * Guards against a user placing a crontick flag (e.g. --engine) after `--`,
 * expecting it to still be parsed as a crontick option. Commander treats
 * everything after a literal `--` as positional, so such a token instead
 * becomes a literal argument to the job's prompt action — silently corrupting
 * the job instead of doing what the user meant.
 *
 * Only long-form flags (`--foo`) registered on this command or the top-level
 * program are checked; short flags (`-v`, `-e`, ...) are common, legitimate
 * literal arguments to a prompt engine (e.g. `-p`) and are not flagged.
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
      'this would otherwise silently store them as literal job arguments. Move crontick flags before the -- delimiter.',
  );
}

const program = new Command();

// exitOverride + a silenced writeErr let us catch Commander usage errors
// (missing argument, unknown option/command) and render a single clean RED
// line ourselves instead of Commander's default multi-line output followed by
// a Node stack trace. See handleTopLevelError.
program.exitOverride();
program.configureOutput({
  writeOut: (str) => process.stdout.write(str),
  writeErr: () => { /* suppressed: errors are rendered by handleTopLevelError */ },
});

program
  .name('crontick')
  .description('A standalone cron daemon, CLI, and MCP server for local scheduled jobs.')
  .version(VERSION)
  .option('-v, --verbose', 'Write crontick diagnostic logs to stderr (also enabled by CRONTICK_VERBOSE=1)')
  .action(() => {
    // Bare `crontick` (no subcommand) prints help and exits 0. An unrecognized
    // subcommand still fails loudly via program.error (rendered red by the
    // top-level handler).
    if (program.args.length > 0) {
      program.error(`unknown command '${program.args[0]}'`);
    }
    program.outputHelp();
  });

// ── jobs ─────────────────────────────────────────────────────────────────────
const jobs = groupHelp(program.command('jobs').description('Create, inspect, and manage scheduled jobs'));

commonJobOptions(jobs.command('new [engineArgs...]').description('Create a new job (alias auto-generated when --alias is omitted)'))
  .option('--force', 'Replace an existing job when the same alias already exists')
  .action(async (engineArgs: string[], opts, cmd: Command) => {
    const c = client();
    try {
      assertNoCrontickFlagCollision(engineArgs, cmd);
      const result = await c.createJobFromCliOptions(collectJobOptions(engineArgs, opts));
      printNotices(c);
      print(result);
    } catch (err) {
      handleError(err);
    }
  });

commonJobOptions(jobs.command('update <id> [engineArgs...]').description('Update an existing job (id or alias)'))
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

jobs.command('list').description('List all jobs').action(async () => {
  try { print(await client().listJobs()); } catch (err) { handleError(err); }
});

jobs.command('get <id>').description('Get a job by id or alias').action(async (id: string) => {
  try { print(await client().getJob(id)); } catch (err) { handleError(err); }
});

jobs.command('schedule <id>')
  .description('Show upcoming fire times for a job (id or alias)')
  .option('-n, --count <n>', 'Number of upcoming fire times to show (default: 5)', parseInteger, 5)
  .action(async (id: string, opts) => {
    try { print(await client().jobSchedule(id, { n: opts.count as number | undefined })); } catch (err) { handleError(err); }
  });

jobs.command('delete [id]')
  .description('Delete a job (id or alias), or all jobs with --all --force')
  .option('--all', 'Delete every job (requires --force)')
  .option('--force', 'Confirm a destructive --all delete')
  .action(async (id: string | undefined, opts) => {
    try {
      if (opts.all) {
        if (!opts.force) throw new CrontickError('VALIDATION_ERROR', '`jobs delete --all` requires --force to confirm deleting every job');
        const c = client();
        const all = await c.listJobs();
        for (const job of all) await c.deleteJob(job.id);
        print({ ok: true, deleted: all.length });
        return;
      }
      if (!id) throw new CrontickError('MISSING_ARG', 'Provide a job id or alias, or use --all --force to delete every job');
      print(await client().deleteJob(id));
    } catch (err) { handleError(err); }
  });

jobs.command('run-now <id>').description('Trigger an immediate run of a job (id or alias)').action(async (id: string) => {
  try { print(await client().runNow(id)); } catch (err) { handleError(err); }
});

// ── runs ─────────────────────────────────────────────────────────────────────
const RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'canceled', 'timeout', 'missed'] as const;

const runs = groupHelp(program.command('runs').description('Inspect and manage run history'));
runs.command('list')
  .description('List recent runs, optionally filtered by job')
  .option('--job <id>', 'Filter by job id or alias')
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

runs.command('get <runId>')
  .description('Show what was run for a run: resolved command, status, timing, and session id')
  .action(async (runId: string) => {
    try { print(await client().getRun(runId)); } catch (err) { handleError(err); }
  });

runs.command('logs <runId> [source]')
  .description('Show logs for a run. Optional source: engine (stdout+stderr) or crontick (scheduling/execution events); default shows both')
  .option('--tail <n>', 'Show last N lines', parseInteger)
  .action(async (runId: string, source: string | undefined, opts) => {
    try {
      const src = (source ?? 'all') as 'all' | 'engine' | 'crontick';
      if (src !== 'all' && src !== 'engine' && src !== 'crontick') {
        throw new CrontickError('VALIDATION_ERROR', `Invalid source '${source}'. Expected one of: engine, crontick (omit for both).`);
      }
      const result = await client().getLogs(runId, { lines: opts.tail as number | undefined, source: src });
      for (const entry of result.lines) process.stdout.write(`[${entry.stream}] ${entry.data}`);
    } catch (err) { handleError(err); }
  });

runs.command('cancel <runId>').description('Cancel an in-progress run').action(async (runId: string) => {
  try { print(await client().cancelRun(runId)); } catch (err) { handleError(err); }
});

runs.command('delete [runId]')
  .description('Delete a run and its crontick-side data (logs), or all runs with --all --force')
  .option('--all', 'Delete every run (requires --force)')
  .option('--force', 'Confirm a destructive --all delete')
  .action(async (runId: string | undefined, opts) => {
    try {
      if (opts.all) {
        if (!opts.force) throw new CrontickError('VALIDATION_ERROR', '`runs delete --all` requires --force to confirm deleting every run');
        print(await client().deleteRun(undefined, { all: true, force: true }));
        return;
      }
      if (!runId) throw new CrontickError('MISSING_ARG', 'Provide a run id, or use --all --force to delete every run');
      print(await client().deleteRun(runId));
    } catch (err) { handleError(err); }
  });

// ── stats ────────────────────────────────────────────────────────────────────
const stats = groupHelp(program.command('stats').description('Show job/run statistics'));
stats.command('summary').description('Show aggregate statistics').action(async () => {
  try { print(await client().statsSummary()); } catch (err) { handleError(err); }
});
stats.command('job <id>').description('Show statistics for one job (id or alias)').action(async (id: string) => {
  try { print(await client().statsJob(id)); } catch (err) { handleError(err); }
});

// ── share ────────────────────────────────────────────────────────────────────
const share = groupHelp(program.command('share').description('Export and import jobs'));
share.command('export')
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

share.command('import <file>').description('Import jobs (and run history, if present) from a JSON file').action(async (file: string) => {
  try {
    const filePath = resolve(process.cwd(), file);
    const data = readJsonFile(filePath, {
      errorCode: 'VALIDATION_ERROR',
      subject: 'import file',
      expectedShape: 'expected either a JSON array of jobs or an export object with jobs and optional runs',
    }) as { jobs?: unknown[]; runs?: unknown[] } | unknown[];
    const importJobs = Array.isArray(data) ? data : data.jobs;
    const importRuns = Array.isArray(data) ? undefined : data.runs;
    print(await client().importJobs(Array.isArray(importJobs) ? importJobs : [], { fileBaseDir: dirname(filePath), runs: importRuns }));
  } catch (err) { handleError(err); }
});

// ── config ───────────────────────────────────────────────────────────────────
// The config file is edited directly by the user; crontick has no get/set/unset
// commands. This prints the path and how edits take effect. startDaemon=false —
// it is a local, read-only operation.
program.command('config')
  .description('Show the config file path (edit that file directly to change config)')
  .action(() => {
    try {
      const info = client(false).configPath();
      stdout(info.path);
      stdout('');
      stdout(info.note);
    } catch (err) { handleError(err); }
  });

// ── info ─────────────────────────────────────────────────────────────────────
program.command('info')
  .description('Show version, runtime, storage locations, and daemon status')
  .action(async () => {
    try {
      const info = await client(false).info();
      stdout(`crontick   ${info.version}`);
      stdout(`node       ${info.node}`);
      stdout(`platform   ${info.platform}`);
      stdout('');
      stdout('paths');
      for (const [key, value] of Object.entries(info.paths)) stdout(`  ${key.padEnd(11)}${value}`);
      stdout('');
      stdout(info.daemon.running
        ? `daemon     running (pid ${String(info.daemon.pid ?? '?')}, port ${String(info.daemon.port ?? '?')})`
        : 'daemon     not running');
    } catch (err) { handleError(err); }
  });

// ── doctor ───────────────────────────────────────────────────────────────────
program.command('doctor').description('Check system health').action(async () => {
  try {
    const result = await client(false).doctor({ mcpScript: mcpScript() });
    for (const check of result.checks) {
      stdout(`${check.ok ? '✓' : '✗'} ${check.name}${check.note ? ` (${check.note})` : ''}`);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) { handleError(err); }
});

// ── daemon ───────────────────────────────────────────────────────────────────
const daemon = groupHelp(program.command('daemon').description('Manage the crontick daemon'));
daemon.command('start')
  .description('Start the daemon')
  .option('--foreground', 'Run in foreground (blocking)')
  .action(async (opts) => {
    try {
      const foreground = opts.foreground === true;
      const result = await client().daemonStart({ foreground });
      if (foreground) process.exit(result.foregroundExitCode ?? 0);
      stdout(result.started ? `Daemon started on port ${String(result.port ?? '')}` : `Daemon already running on port ${String(result.port ?? '')}`);
    } catch (err) { handleError(err); }
  });
daemon.command('stop').description('Stop the daemon').action(async () => {
  try {
    const result = await client(false).daemonStop();
    stdout(`${result.message} (mode: ${result.mode})`);
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
    stdout(`Daemon restarted on port ${String(result.port ?? '')}`);
  } catch (err) { handleError(err); }
});

// ── dashboard ────────────────────────────────────────────────────────────────
const dashboard = groupHelp(program.command('dashboard').description('Manage the crontick dashboard'));
dashboard.command('start')
  .description('Start the dashboard server')
  .option('--open', 'Open in the default browser')
  .action(async (opts) => {
    try {
      const result = await client().dashboardStart();
      if (opts.open as boolean) openDashboardUrl(result.url);
      stdout(`Dashboard ${opts.open ? 'opened' : 'running'}: ${result.url}`);
    } catch (err) { handleError(err); }
  });
dashboard.command('status').description('Show dashboard status').action(async () => {
  try {
    const result = await client(false).dashboardStatus();
    stdout(`Dashboard ${result.running ? 'running' : 'stopped'}: ${result.url}`);
  } catch (err) { handleError(err); }
});
dashboard.command('stop').description('Stop the dashboard server').action(async () => {
  try {
    const result = await client(false).dashboardStop();
    stdout(result.message);
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
      stderr(red(`error: MCP server script not found: ${script}. Run: npm run build`));
      process.exit(1);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.startDaemon === false) env['CRONTICK_MCP_START_DAEMON'] = '0';
    if (opts.daemonUrl) env['CRONTICK_DAEMON_URL'] = opts.daemonUrl as string;
    if (useVerbose()) env['CRONTICK_VERBOSE'] = '1';
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
    process.exit(result.status ?? 0);
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleTopLevelError(err);
  }
}

void main();

