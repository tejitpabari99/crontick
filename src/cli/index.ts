/**
 * CLI shim — thin adapter over CrontickClient via Commander v12.
 * Translates flags/positionals into client method calls, formats output to
 * stdout (JSON or tabular), and prints errors to stderr with exit code 1.
 * Contains no business logic; all scheduling, persistence, and validation live
 * in the client and daemon.
 */
import { Command, InvalidArgumentError } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SCHEDULE_FLAGS, scheduleFooter, type ScheduleFlag } from '../constants/cli-schedule.js';
import { VERSION } from '../version.js';
import { CrontickError } from '../errors.js';
import { createClient, type CrontickClient } from '../client.js';
import { buildJobPatchFromUpdateOptions, type JobCreateCliOptions, type JobPatchCliOptions } from '../job-input.js';
import { isVerboseEnv, type LogEvent } from '../logger.js';
import { readJsonFile } from '../json-file.js';
import { formatJobStats, formatRunDetail, formatRunsTable } from '../run-format.js';
import { resolveExportPath } from '../share.js';
import { deleteRunsWithConfirm, formatDeleteRunsSummary, terminalConfirmIo } from './confirm.js';
import { terminalTrustPromptIo, withTrustPrompt } from './trust-prompt.js';
import { flattenConfigLines, formatConfigValue, terminalInFlightIo, writeConfigWithInFlight } from './config-write.js';
import { parseConfigValue } from '../utils/config-value.js';

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

function scheduleFlag(flag: string): ScheduleFlag {
  const found = SCHEDULE_FLAGS.find((f) => f.flag === flag);
  if (!found) throw new Error(`Unknown schedule flag: ${flag}`);
  return found;
}

function commonJobOptions(command: Command): Command {
  return command
    .option('-a, --alias <alias>', 'Unique kebab-case job alias (auto-generated when omitted)')
    .option('-p, --prompt <text>', 'Prompt text for a prompt action')
    .option('--prompt-file <path>', 'UTF-8 .txt file to read into the prompt')
    .option(`${scheduleFlag('--cron').flag} ${scheduleFlag('--cron').arg}`, scheduleFlag('--cron').description)
    .option(`${scheduleFlag('--every').flag} ${scheduleFlag('--every').arg}`, scheduleFlag('--every').description, parseEveryInterval)
    .option(`${scheduleFlag('--at').flag} ${scheduleFlag('--at').arg}`, scheduleFlag('--at').description)
    .option(`${scheduleFlag('--after').flag} ${scheduleFlag('--after').arg}`, scheduleFlag('--after').description)
    .option('--after-status <status>', 'With --after: which upstream outcome triggers this job: success|failure|any (default: success)')
    .option('--dir <path>', 'Directory the job runs in (default: current directory)')
    .option('--trust-folder', 'Trust the working directory in Claude without asking (when it is not trusted yet)')
    .option('--runner <runner>', 'Configured prompt engine name (default: config defaultEngine)')
    .option('--session-id <id>', 'Resume an existing session ID on every run (implies reuse)')
    .option('--reuse-session', 'Start a new session and resume it on succeeding runs.')
    .option('--file <path>', 'Create the job from a full job-definition JSON file (advanced)')
    // No hardcoded default here (unlike most flags): a Commander default would
    // be indistinguishable from the user explicitly typing the same value,
    // which on `update` previously caused an omitted flag to silently reset
    // a customized overlap policy back to the default. Leaving it undefined
    // when omitted lets job-input.ts tell "not specified" apart from
    // "explicitly set to the default value" on both `new` and `update`.
    // `new` still defaults to skip explicitly in job-input.ts.
    .option('--timeout <sec>', 'Per-run timeout in seconds (default: none/unbounded; omit on update to leave unchanged)', parseInteger)
    .option('--overlap <policy>', 'Overlap policy: skip|queue|cancel-previous (default: skip)')
    .option('--retry <max>', 'Retry count on failure (default: 0; omit on update to leave unchanged)', parseInteger)
    .option('--desc <description>', 'Job description');
}

function collectJobOptions(engineArgs: string[], passthroughArgs: string[], cliArgvOrder: string[], opts: Record<string, unknown>): JobCreateCliOptions {
  return {
    alias: stringOption(opts.alias),
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    passthroughArgs,
    cliArgvOrder,
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    after: stringOption(opts.after),
    afterStatus: stringOption(opts.afterStatus),
    cwd: stringOption(opts.dir),
    trustFolder: booleanOption(opts.trustFolder),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.runner),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
    timeout: numberOption(opts.timeout),
    overlap: stringOption(opts.overlap),
    retry: numberOption(opts.retry),
    desc: stringOption(opts.desc),
    force: booleanOption(opts.force),
  };
}

function collectPatchOptions(engineArgs: string[], passthroughArgs: string[], cliArgvOrder: string[], opts: Record<string, unknown>): JobPatchCliOptions {
  return {
    alias: stringOption(opts.alias),
    rawArgs: Array.isArray(engineArgs) ? engineArgs : [],
    passthroughArgs,
    cliArgvOrder,
    file: stringOption(opts.file),
    cron: stringOption(opts.cron),
    every: numberOption(opts.every),
    at: stringOption(opts.at),
    after: stringOption(opts.after),
    afterStatus: stringOption(opts.afterStatus),
    cwd: stringOption(opts.dir),
    trustFolder: booleanOption(opts.trustFolder),
    prompt: stringOption(opts.prompt),
    promptFile: stringOption(opts.promptFile),
    engine: stringOption(opts.runner),
    sessionId: stringOption(opts.sessionId),
    reuseSession: booleanOption(opts.reuseSession),
    timeout: numberOption(opts.timeout),
    overlap: stringOption(opts.overlap),
    retry: numberOption(opts.retry),
    desc: stringOption(opts.desc),
    unset: Array.isArray(opts.unset) ? (opts.unset as string[]) : undefined,
    // Forward the raw flags; the --enable/--disable mutual-exclusion rule and
    // the resolution to `enabled` live in core (buildJobPatchFromUpdateOptions).
    enable: booleanOption(opts.enable),
    disable: booleanOption(opts.disable),
  };
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError(`Invalid integer: ${value}`);
  return parsed;
}

function parseEveryInterval(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value);
  if (!match) throw new InvalidArgumentError(`Invalid interval: ${value}. Use seconds or an s/m/h/d suffix.`);
  const units: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(match[1]) * units[match[2]!]!;
  if (!Number.isSafeInteger(seconds)) throw new InvalidArgumentError(`Interval is too large: ${value}`);
  return seconds;
}

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
 * Guards against a user placing a crontick flag (e.g. --runner) after `--`,
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

/** Separate unrecognized long flags from positional args that Commander leaves in one array. */
function splitPromptEngineArgs(engineArgs: string[]): { rawArgs: string[]; passthroughArgs: string[] } {
  const separator = process.argv.indexOf('--', 2);
  const afterSeparator = separator < 0 ? [] : process.argv.slice(separator + 1);
  // A literal `--` may itself be a known option's value. In that case it did
  // not start a positional suffix and should not affect this split.
  const hasSeparator = separator >= 0
    && afterSeparator.length <= engineArgs.length
    && afterSeparator.every((arg, i) => arg === engineArgs[engineArgs.length - afterSeparator.length + i]);
  const beforeSeparator = hasSeparator && afterSeparator.length > 0
    ? engineArgs.slice(0, -afterSeparator.length)
    : engineArgs;
  const rawArgs: string[] = [];
  const passthroughArgs: string[] = [];

  for (const tokens of [beforeSeparator, hasSeparator ? afterSeparator : []]) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith('--') && token.length > 2) {
        // Removed CLI switches must stay unknown instead of being forwarded
        // to the prompt runner through the generic long-flag passthrough.
        const flag = token.split('=', 1)[0]!;
        if (flag === '--job-env-file' || flag === '--engine' || flag === '--tz' || flag === '--cwd') {
          throw new Error(`unknown option '${flag}'`);
        }
        passthroughArgs.push(token);
        if (!token.includes('=') && i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) {
          passthroughArgs.push(tokens[++i]!);
        }
      } else if (token === '-C') {
        // Removed short flag: unknown everywhere, including after `--`.
        throw new Error(`unknown option '${token}'`);
      } else if (tokens === beforeSeparator && token.startsWith('-')) {
        throw new CrontickError('VALIDATION_ERROR', `Unknown short option: ${token}`);
      } else {
        rawArgs.push(token);
      }
    }
  }
  return { rawArgs, passthroughArgs };
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
  .allowUnknownOption()
  .addHelpText('after', scheduleFooter())
  .option('--force', 'Replace an existing job when the same alias already exists')
  .action(async (engineArgs: string[], opts, cmd: Command) => {
    const c = client();
    try {
      assertNoCrontickFlagCollision(engineArgs, cmd);
      const { rawArgs, passthroughArgs } = splitPromptEngineArgs(engineArgs);
      const options = collectJobOptions(rawArgs, passthroughArgs, engineArgs, opts);
      const result = await withTrustPrompt(
        (trustFolder) => c.createJobFromCliOptions({ ...options, trustFolder }),
        { trustFolder: options.trustFolder, io: terminalTrustPromptIo() },
      );
      printNotices(c);
      print(result);
    } catch (err) {
      handleError(err);
    }
  });

commonJobOptions(jobs.command('update <id|alias> [engineArgs...]').description('Update an existing job (id or alias)'))
  .allowUnknownOption()
  .option('--enable', 'Enable the job')
  .option('--disable', 'Disable the job')
  .option('--unset <field>', 'Remove an optional field: timeout, session-id, desc (repeatable or comma-separated)', collectOption, [] as string[])
  .option('--stop-running', 'If the job has runs in flight, cancel them (and drop queued ones), then apply (prompts on a terminal when neither flag is given)')
  .option('--wait-running', 'If the job has runs in flight, pause the job, wait for them to finish, apply, then resume it')
  .action(async (id: string, engineArgs: string[], opts, cmd: Command) => {
    const c = client();
    const notices: string[] = [];
    try {
      assertNoCrontickFlagCollision(engineArgs, cmd);
      const { rawArgs, passthroughArgs } = splitPromptEngineArgs(engineArgs);
      const patchOptions = collectPatchOptions(rawArgs, passthroughArgs, engineArgs, opts);
      const patch = buildJobPatchFromUpdateOptions(patchOptions, {
        cwd: process.cwd(),
        onNotice: (message) => notices.push(message),
      });
      const result = await writeConfigWithInFlight(
        (inFlight) => withTrustPrompt(
          (trustFolder) => c.updateJob(id, patch, { trustFolder, inFlight }),
          { trustFolder: patchOptions.trustFolder, io: terminalTrustPromptIo() },
        ),
        { stopRunning: booleanOption(opts.stopRunning), waitRunning: booleanOption(opts.waitRunning) },
        terminalInFlightIo(),
        { subject: 'job' },
      );
      printNotices(c, notices);
      print(result);
    } catch (err) {
      handleError(err);
    }
  });

jobs.command('list').description('List all jobs').action(async () => {
  try { print(await client().listJobs()); } catch (err) { handleError(err); }
});

jobs.command('get <id|alias>').description('Get a job by id or alias').action(async (id: string) => {
  try {
    const job = await client().getJob(id);
    print(job);
    if (job.action.cwd) stdout(`cwd: ${job.action.cwd}`);
    if (job.action.sessionId) stdout(`Runner Session ID: ${job.action.sessionId}`);
  } catch (err) { handleError(err); }
});

jobs.command('schedule <id|alias>')
  .description('Show upcoming fire times for a job (id or alias)')
  .option('-n, --count <n>', 'Number of upcoming fire times to show (default: 5)', parseInteger, 5)
  .action(async (id: string, opts) => {
    try {
      const { enabled, next, ...rest } = await client().jobSchedule(id, { n: opts.count as number | undefined }) as { enabled: boolean; next: unknown } & Record<string, unknown>;
      print({ ...rest, status: enabled ? 'enabled' : 'disabled', next });
    } catch (err) { handleError(err); }
  });

jobs.command('delete <id|alias>')
  .description('Delete a job (id or alias), or delete all jobs with the reserved `all` keyword and --force')
  .option('--force', 'Confirm deleting all jobs, or delete a job even though other jobs run after it (they are disabled)')
  .action(async (idOrAlias: string, opts) => {
    try {
      if (idOrAlias === 'all') {
        // Force validation lives in the core client (deleteJob enforces
        // force:true for the all-path); the shim just forwards the intent.
        print(await client().deleteJob(undefined, { all: true, force: booleanOption(opts.force) }));
        return;
      }
      print(await client().deleteJob(idOrAlias, { force: booleanOption(opts.force) }));
    } catch (err) { handleError(err); }
  });

jobs.command('run-now <id|alias>').description('Run a job once right now, even if it is disabled (does not enable it or change its schedule)').action(async (id: string) => {
  try { print(await client().runNow(id)); } catch (err) { handleError(err); }
});

// ── runs ─────────────────────────────────────────────────────────────────────
const RUN_STATUSES = ['queued', 'running', 'success', 'failed', 'canceled', 'skipped', 'timeout', 'missed'] as const;

const runs = groupHelp(program.command('runs').description('Inspect and manage run history'));
runs.command('list')
  .description('List recent runs, optionally filtered by job')
  .option('--job <id|alias>', 'Filter by job id or alias')
  .option('--limit <n>', 'Maximum runs to return', parseInteger)
  .option('--since <ms>', 'Only runs since epoch milliseconds', parseInteger)
  .option('--status <status>', `Filter by run status (${RUN_STATUSES.join('|')})`)
  .option('--json', 'Print the raw run records as JSON (epoch-millisecond timestamps, full error text)')
  .action(async (opts) => {
    try {
      const listed = await client().listRuns({
        jobId: opts.job as string | undefined,
        limit: opts.limit as number | undefined,
        since: opts.since as number | undefined,
        status: opts.status as string | undefined,
      });
      if (opts.json) stdout(JSON.stringify(listed, null, 2));
      else stdout(listed.length === 0 ? '(no items)' : formatRunsTable(listed));
    } catch (err) { handleError(err); }
  });

runs.command('get <runId>')
  .description('Show a run: status, timing, Runner Session ID, transcript and log file paths, then its cleaned output')
  .option('--json', 'Print { run, output } as JSON (epoch-millisecond timestamps)')
  .action(async (runId: string, opts) => {
    try {
      const c = client();
      const run = await c.getRun(runId);
      const output = await c.getOutput(runId);
      stdout(opts.json ? JSON.stringify({ run, output }, null, 2) : formatRunDetail(run, output));
    } catch (err) { handleError(err); }
  });

runs.command('cancel <runId>').description('Cancel an in-progress run').action(async (runId: string) => {
  try { print(await client().cancelRun(runId)); } catch (err) { handleError(err); }
});


runs.command('delete [runIds...]')
  .description('Delete runs (and their stored output) by run id, or all runs of a job with --job. Active runs are skipped.')
  .option('--job <id|alias>', 'Delete every run of this job (id or alias; a deleted job\'s raw id also works)')
  .option('--force', 'Skip the confirmation prompt (required when not on a terminal)')
  .option('--dry-run', 'Show what would be deleted without deleting')
  .option('--json', 'Print the full result as JSON')
  .action(async (runIds: string[], opts) => {
    try {
      const ids = runIds ?? [];
      if ((opts.job !== undefined) === (ids.length > 0)) {
        throw new CrontickError('VALIDATION_ERROR', 'Provide run ids or --job <id|alias> (not both).');
      }
      const dryRun = opts.dryRun === true;
      const result = await deleteRunsWithConfirm(client(), {
        ...(opts.job !== undefined ? { job: opts.job as string } : { runIds: ids }),
        force: opts.force === true,
        dryRun,
      }, terminalConfirmIo());
      stdout(opts.json ? JSON.stringify(result, null, 2) : formatDeleteRunsSummary(result, dryRun));
      if (result.notFound.length > 0) process.exitCode = 1;
    } catch (err) { handleError(err); }
  });


// ── stats ────────────────────────────────────────────────────────────────────
const stats = groupHelp(program.command('stats').description('Show job/run statistics'));
stats.command('summary').description('Show aggregate statistics').action(async () => {
  try { print(await client().statsSummary()); } catch (err) { handleError(err); }
});
stats.command('job <id|alias>').description('Show statistics for one job (id or alias); totalTurns sums the agent turns of all its runs').action(async (id: string) => {
  try { print(formatJobStats(await client().statsJob(id))); } catch (err) { handleError(err); }
});

// ── share ────────────────────────────────────────────────────────────────────
const share = groupHelp(program.command('share').description('Export and import jobs'));
share.command('export')
  .description('Export jobs to a crontick export file (schema 1, jobs only)')
  .option('--out <file>', 'Output file; ".json" is appended unless the name already ends in .json (default: print to stdout)')
  .option('--only-jobs <id|alias,...>', 'Comma-separated ids or aliases of the jobs to export (default: all jobs)')
  .action(async (opts) => {
    try {
      const onlyJobs = typeof opts.onlyJobs === 'string' ? opts.onlyJobs.split(',').map((v: string) => v.trim()).filter(Boolean) : undefined;
      const data = await client().exportJobs({ onlyJobs });
      const json = JSON.stringify(data, null, 2);
      if (opts.out) {
        const target = resolveExportPath(opts.out as string, process.cwd());
        writeFileSync(target, `${json}\n`, 'utf-8');
        stdout(`Exported ${data.jobs.length} job(s) to ${target}`);
      } else {
        stdout(json);
      }
    } catch (err) { handleError(err); }
  });

share.command('import <file>')
  .description('Import jobs from a crontick export file (schema 1). Jobs get new ids.')
  .option('--trust-folder', 'Trust the jobs\' working directories in Claude without asking (when not trusted yet)')
  .action(async (file: string, opts) => {
    try {
      const filePath = resolve(process.cwd(), file);
      const data = readJsonFile(filePath, {
        errorCode: 'VALIDATION_ERROR',
        subject: 'import file',
        expectedShape: 'expected a crontick export object: {"schema": 1, "jobs": [...]}',
      });
      const c = client();
      print(await withTrustPrompt(
        (trustFolder) => c.importJobs(data, { fileBaseDir: dirname(filePath), trustFolder }),
        { trustFolder: booleanOption(opts.trustFolder), io: terminalTrustPromptIo() },
      ));
    } catch (err) { handleError(err); }
  });

// ── config ───────────────────────────────────────────────────────────────────
// File-direct (no daemon demand-start): works even when the daemon is down or broken.
const config = groupHelp(program.command('config').description('List, read, set, and unset config values (dotted keys, e.g. defaults.timeoutSec)'));

function inFlightOptions(command: Command): Command {
  return command
    .option('--stop-running', 'If runs are in flight, cancel them, then apply (prompts on a terminal when neither flag is given)')
    .option('--wait-running', 'If runs are in flight, pause the daemon, wait for them to finish, apply, then resume');
}

function printConfigWrite(result: Awaited<ReturnType<CrontickClient['configSet']>>): void {
  stdout(`changed: ${result.changed.length > 0 ? result.changed.join(', ') : '(nothing)'}`);
  stdout(`reload: ${result.reload}`);
  for (const warning of result.warnings) stderr(`Warning: ${warning}`);
  stderr(result.notice);
}

config.command('list')
  .description('Show the effective config as key = value lines; keys not in the config file are tagged (default)')
  .option('--json', 'Print the full structured result as JSON')
  .action((opts) => {
    try {
      const result = client(false).configList();
      if (opts.json) stdout(JSON.stringify(result, null, 2));
      else for (const line of flattenConfigLines(result.config, result.stored)) stdout(line);
    } catch (err) { handleError(err); }
  });

config.command('get <key>')
  .description('Print one effective config value (secrets are redacted)')
  .action((key: string) => {
    try { stdout(formatConfigValue(client(false).configGet(key))); } catch (err) { handleError(err); }
  });

inFlightOptions(config.command('set <key> <value>')
  .description('Set a config value. The value is parsed as JSON, falling back to a plain string; arrays/objects are JSON; put -- before a negative number. Engines: config set engines.<name> \'{"command":"...","type":"raw"}\'')
  .option('--string', 'Treat the value as a string (e.g. a command named 123)'))
  .action(async (key: string, value: string, opts) => {
    try {
      const c = client(false);
      const parsed = parseConfigValue(value, { string: booleanOption(opts.string) });
      const result = await writeConfigWithInFlight(
        (inFlight) => c.configSet(key, parsed, { inFlight }),
        { stopRunning: booleanOption(opts.stopRunning), waitRunning: booleanOption(opts.waitRunning) },
        terminalInFlightIo(),
      );
      printConfigWrite(result);
    } catch (err) { handleError(err); }
  });

inFlightOptions(config.command('unset <key>')
  .description('Remove a config key (reverts to its default). Engines: config unset engines.<name>'))
  .action(async (key: string, opts) => {
    try {
      const c = client(false);
      const result = await writeConfigWithInFlight(
        (inFlight) => c.configUnset(key, { inFlight }),
        { stopRunning: booleanOption(opts.stopRunning), waitRunning: booleanOption(opts.waitRunning) },
        terminalInFlightIo(),
      );
      printConfigWrite(result);
    } catch (err) { handleError(err); }
  });

// ── info ─────────────────────────────────────────────────────────────────────

const info = program.command('info')
  .description('Show version, runtime, config path, storage locations, and daemon status')
  .usage('[options]')
  .argument('[extra...]')
  .action(async () => {
    // `info` has no subcommands: a stray word (e.g. the removed `info daemon`) is an error.
    if (info.args.length > 0) info.error(`unknown command '${info.args[0]}'`);
    try {
      const result = await client(false).info();
      stdout(`crontick   ${result.version}`);
      stdout(`node       ${result.node}`);
      stdout(`platform   ${result.platform}`);
      stdout('');
      stdout(result.daemon.running
        ? `daemon     running (pid ${String(result.daemon.pid ?? '?')}, port ${String(result.daemon.port ?? '?')})`
        : 'daemon     stopped (starts automatically on first use, or run: crontick daemon start)');
      if (result.daemon.portNote) stdout(`           ${result.daemon.portNote}`);
      stdout(`config     ${result.configPath}${result.configExists ? '' : ' (not created yet - built-in defaults in use)'}`);
      stdout(result.dashboardUrl
        ? `dashboard  ${result.dashboardUrl}${result.daemon.running ? '' : ' (available once the daemon is running; it starts automatically on first use)'}`
        : 'dashboard  available once the daemon is running (it starts automatically on first use)');
      stdout('');
      stdout('paths');
      for (const key of ['dataDir', 'jobsDir', 'logsDir', 'runsDb', 'portFile', 'pidFile'] as const) {
        stdout(`  ${key.padEnd(11)}${result.paths[key]}`);
      }
    } catch (err) { handleError(err); }
  });

async function runDoctor(): Promise<void> {
  try {
    const result = await client(false).doctor({ mcpScript: mcpScript() });
    for (const check of result.checks) {
      stdout(`${check.ok ? '✓' : '✗'} ${check.name}${check.note ? ` (${check.note})` : ''}`);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) { handleError(err); }
}

program.command('doctor').description('Check system health').action(runDoctor);

// ── daemon ───────────────────────────────────────────────────────────────────
// The daemon still demand-starts on first use; `daemon start` is the explicit,
// manual way to start it (or run it in the foreground). It is NOT login/boot
// registration; only the opt-in `crontick autostart enable` registers anything
// (see tests/unit/autostart-removal.test.ts).

const daemon = groupHelp(program.command('daemon').description('Start, stop, and inspect the background daemon'));
daemon.command('start')
  .description('Start the daemon now (background by default; it also starts automatically on first use)')
  .option('--foreground', 'Run the daemon in this terminal until it exits (Ctrl+C to stop)')
  .option('--home <dir>', 'Data directory for the started daemon (sets CRONTICK_HOME)')
  .action(async (opts) => {
    try {
      const result = await client().daemonStart({ foreground: booleanOption(opts.foreground), home: stringOption(opts.home) });
      if (result.foregroundExitCode !== undefined) {
        stdout(`Daemon exited (code ${String(result.foregroundExitCode)})`);
        return;
      }
      stdout(result.started
        ? `Daemon started (pid ${String(result.pid ?? '?')}, ${result.baseUrl})`
        : `Daemon already running (pid ${String(result.pid ?? '?')}, ${result.baseUrl})`);
      if (result.portNote) stdout(`Note: ${result.portNote}`);
    } catch (err) { handleError(err); }
  });
daemon.command('stop').description('Stop the daemon').action(async () => {
  try {
    const result = await client(false).daemonStop();
    stdout(`${result.message} (mode: ${result.mode})`);
  } catch (err) { handleError(err); }
});
daemon.command('restart').description('Stop the daemon and start it again').action(async () => {
  try {
    const result = await client().daemonRestart();
    stdout(`Daemon restarted (pid ${String(result.pid ?? '?')}, ${result.baseUrl})`);
    if (result.portNote) stdout(`Note: ${result.portNote}`);
  } catch (err) { handleError(err); }
});
daemon.command('status').description('Show whether the daemon is running').action(async () => {
  try {
    print(await client(false).daemonStatus());
  } catch (err) {
    if (err instanceof CrontickError && err.code === 'DAEMON_NOT_RUNNING') {
      stdout('Daemon is not running (start it with: crontick daemon start)');
      process.exitCode = 1;
      return;
    }
    handleError(err);
  }
});
daemon.command('reload').description('Reload jobs from disk').action(async () => {
  try { print(await client().daemonReload()); } catch (err) { handleError(err); }
});
daemon.command('pause').description('Pause scheduling: the daemon stays up but starts no new runs; fires due while paused are recorded as skipped').action(async () => {
  try { print(await client().daemonPause()); } catch (err) { handleError(err); }
});
daemon.command('resume').description('Resume scheduling after a pause').action(async () => {
  try { print(await client().daemonResume()); } catch (err) { handleError(err); }
});

// ── autostart ────────────────────────────────────────────────────────────────
// Opt-in login registration with the OS user service manager. `daemon start`
// never registers anything; only `autostart enable` does. No daemon needed.

const autostart = groupHelp(program.command('autostart').description('Start the daemon automatically at login (opt-in)'));
autostart.command('enable').description('Register the daemon to start at login (idempotent)').action(async () => {
  try {
    const r = await client(false).autostartEnable();
    stdout(`Autostart enabled (${r.mechanism})`);
    stdout(`definition  ${r.definitionPath}`);
    for (const hint of r.hints) stdout(`Note: ${hint}`);
  } catch (err) { handleError(err); }
});
autostart.command('disable').description('Remove the login registration (idempotent)').action(async () => {
  try {
    const r = await client(false).autostartDisable();
    stdout(r.removed ? 'Autostart disabled' : 'Autostart was not enabled; nothing to remove');
  } catch (err) { handleError(err); }
});
autostart.command('status').description('Show whether the daemon is registered to start at login').action(async () => {
  try {
    const s = await client(false).autostartStatus();
    stdout(`autostart  ${!s.supported ? 'unsupported' : s.enabled ? 'enabled' : 'disabled'}`);
    if (s.mechanism) stdout(`mechanism  ${s.mechanism}`);
    if (s.definitionPath) stdout(`definition ${s.definitionPath}`);
    if (s.command) stdout(`command    ${s.command}`);
    if (s.active !== undefined) stdout(`active     ${s.active ? 'yes' : 'no'}`);
    if (s.reason) stdout(`reason     ${s.reason}`);
    if (s.stale) {
      stdout('stale      yes');
      for (const reason of s.staleReasons) stdout(`  - ${reason}`);
    }
    for (const hint of s.hints) stdout(`Note: ${hint}`);
  } catch (err) { handleError(err); }
});

// ── dashboard ────────────────────────────────────────────────────────────────
// The dashboard has no dedicated command group: it is always served by the
// daemon on its loopback port (routes '/', '/dashboard', '/dashboard/*'). Run
// `crontick info` to get the dashboard URL and open it in a browser.

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
