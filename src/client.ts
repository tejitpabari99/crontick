/**
 * Core client — the single programmatic entry point for all crontick operations.
 * CLI, MCP, and library surfaces are thin shims that instantiate this class and
 * call its methods; no business logic lives outside this module and the daemon.
 *
 * Communication with the daemon is via loopback HTTP. If the daemon is not
 * running, the client demand-starts it (unless `startDaemon` is false).
 * Transport failures are converted to structured `CrontickError` instances with
 * machine-readable codes; see `src/errors.ts`.
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { CrontickError } from './errors.js';
import type { RunOutput } from './run-output.js';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDaemon,
  resolveDaemonBaseUrl,
  type DaemonInfo,
  type EnsureDaemonOptions,
} from './daemon/ensure.js';
import { getEngineAdapter } from './engines/registry.js';
import { restartDaemon, startDaemon, stopDaemon, type DaemonRestartResult, type DaemonStartResult, type DaemonStopResult } from './daemon/lifecycle.js';
import { ScheduleSchema, type Job, type Schedule } from './schemas/job.js';
import {
  buildJobFromCreateOptions,
  ExportFileSchema,
  normalizeJobInput,
  normalizeJobPatch,
  type ExportFile,
  type JobCreateCliOptions,
  type JobCreateInput,
  type JobPatchInput,
  type NormalizeJobInputOptions,
} from './job-input.js';
import { runDoctorChecks, type DoctorOptions, type DoctorResult } from './doctor.js';
import { jobJsonSchema } from './schema-json.js';
import {
  dashboardDaemonDownError,
  type DashboardData,
  type DashboardOptions,
  type DashboardStatus,
} from './dashboard.js';
import {
  addEngine,
  getConfigValue,
  initConfig,
  listEngines,
  loadConfig,
  redactConfigForRead,
  removeConfigValue,
  removeEngine,
  setConfigValue,
  updateEngine,
  validateConfigFile,
  configFilePath,
  ensureConfigFile,
  type ConfigValidationResult,
  type CrontickConfig,
  type EngineConfig,
} from './config.js';
import { createLogger, isVerboseEnv, type Logger, type LogSink } from './logger.js';
import { dataDir, jobsDir, logsDir, pidFilePath, portFilePath, runsDbPath } from './paths.js';
import { VERSION } from './version.js';

export interface CrontickClientOptions extends Omit<EnsureDaemonOptions, 'startDaemon' | 'logger'> {
  requestTimeoutMs?: number;
  cwd?: string;
  startDaemon?: boolean;
  mcpScript?: string;
  verbose?: boolean;
  onLog?: LogSink;
  logger?: Logger;
}

export interface CreateJobOptions extends NormalizeJobInputOptions {
  force?: boolean;
  /** Mark the job's working directory as trusted in Claude when it is not yet (otherwise TRUST_REQUIRED is thrown). */
  trustFolder?: boolean;
}

export interface UpdateJobOptions extends NormalizeJobInputOptions {
  /** Mark the job's working directory as trusted in Claude when it is not yet (otherwise TRUST_REQUIRED is thrown). */
  trustFolder?: boolean;
}

// Bundled layout: client.ts's compiled chunk and index.js both live directly
// under dist/, with dist/daemon/index.js and dist/mcp/index.js as siblings --
// see tsup.config.ts. Library consumers who never pass an explicit
// daemonScript/mcpScript (the common case; see README's Library quick start)
// otherwise fell through to daemon/ensure.ts's own import.meta.url-relative
// fallback, which assumes ensure.ts's *source* sibling layout (src/daemon/) and
// resolves to the wrong file once bundled. Defaulting here, relative to this
// module's own bundled location, is correct for both the installed package and
// this repo's dist/.
const distDir = dirname(fileURLToPath(import.meta.url));
function defaultDaemonScript(): string {
  return resolvePath(distDir, 'daemon', 'index.js');
}
function defaultMcpScript(): string {
  return resolvePath(distDir, 'mcp', 'index.js');
}

export type { RunOutput, ExportFile };

/** Result of `importJobs`: one row per job; `renamedFrom` is set when the alias was suffixed to avoid a collision. */
export interface ImportResult {
  imported: number;
  results: Array<{ id: string; alias?: string; ok: boolean; renamedFrom?: string; error?: string }>;
}

export interface StatsSummary {
  totalJobs: number;
  enabledJobs: number;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  /** Average execution time in seconds (2 decimals) over runs that finished executing; null when none. */
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}

/** Run fields returned by getRun() and listRuns() on all three surfaces. */
export interface RunRecord {
  id: string;
  jobId: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  exitCode?: number;
  error?: string;
  durationMs?: number;
  pid?: number;
  outputTruncated: boolean;
  sessionId?: string;
  command?: string;
  costUsd?: number;
  turns?: number;
  usageJson?: string;
  transcriptPath?: string;
  engineStatus?: string;
  /** Absolute path of the per-job log file (crontick-side events only, all runs of the job); null when file logging is off. Only set by getRun(). */
  logFile?: string | null;
  /** Whether the file at `logFile` exists on disk. Only set by getRun(), when `logFile` is not null. */
  logFileExists?: boolean;
  /** Whether the file at `transcriptPath` exists on disk. Only set by getRun(), when `transcriptPath` is set. */
  transcriptExists?: boolean;
}

export interface JobStats {
  jobId: string;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  lastStatus: string | null;
  lastRunAt: number | null;
  /** Average execution time in seconds (2 decimals) over runs that finished executing; null when none. */
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}

interface DaemonMissedFiresSummary {
  jobsWithMissedFires: number;
  missedRunsRecorded: number;
  jobsCapped: number;
  capPerJob: number;
}

export interface DaemonStatus {
  pid: number;
  version: string;
  port: number;
  baseUrl: string;
  /** Dashboard URL served by this daemon. */
  dashboardUrl: string;
  /** `started on fallback port N; default 47615 is in use` when the daemon is not on the preferred port, else null. */
  portNote: string | null;
  uptimeSec: number;
  jobs: number;
  missedFires: DaemonMissedFiresSummary;
}

export interface CrontickInfoPaths {
  dataDir: string;
  jobsDir: string;
  runsDb: string;
  logsDir: string;
  configFile: string;
  portFile: string;
  pidFile: string;
}

export interface CrontickInfo {
  version: string;
  node: string;
  platform: string;
  configPath: string;
  /** Whether the config file exists on disk. When false, built-in defaults are in use (create it with initConfig). */
  configExists: boolean;
  paths: CrontickInfoPaths;
  daemon: { running: boolean; pid?: number; port?: number; portNote?: string | null };
  /**
   * URL of the daemon-served dashboard, or null when it cannot be resolved
   * (no running daemon and no readable port file). The dashboard is always
   * served by the daemon whenever it is up; `info` never starts the daemon.
   */
  dashboardUrl: string | null;
}

export interface ConfigPathInfo {
  path: string;
  note: string;
}


interface HttpTextResponse {
  status: number;
  ok: boolean;
  text: string;
}

export class CrontickClient {
  private readonly options: CrontickClientOptions;
  private readonly verbose: boolean;
  private readonly logger: Logger;
  /** Cached after first successful `ensure()` to avoid redundant port-file reads. */
  private cachedBaseUrl?: string;
  /** Accumulated notices from normalizeJobInput; drained by surfaces after each op. */
  private notices: string[] = [];

  constructor(options: CrontickClientOptions = {}) {
    // Default daemonScript/mcpScript so library consumers who never set them
    // (the documented createClient() quick start) resolve the real bundled
    // daemon/mcp entry points instead of ensure.ts's broken source-relative
    // fallback (see defaultDaemonScript above).
    this.options = {
      ...options,
      daemonScript: options.daemonScript ?? defaultDaemonScript(),
      mcpScript: options.mcpScript ?? defaultMcpScript(),
    };
    this.verbose = options.verbose ?? isVerboseEnv(options.env ?? process.env);
    this.logger = (options.logger ?? createLogger({
      verbose: this.verbose,
      sink: options.onLog,
      component: 'client',
    }));
  }

  /** Resolves daemon URL, probes health, and demand-starts if needed. Library-only (not in surface parity). */
  async ensure(): Promise<DaemonInfo> {
    this.logger.debug('Ensuring daemon', { startDaemon: this.shouldStartDaemon() });
    try {
      // First use writes the full default config.json so it can be discovered
      // and edited; an existing file is never touched. Best-effort only.
      ensureConfigFile({ env: this.effectiveEnv(), logger: this.logger.child('config') });
    } catch (err) {
      this.logger.debug('Default config file could not be created', { error: errorMessage(err) });
    }
    const info = await ensureDaemon({
      ...this.options,
      env: this.effectiveEnv(),
      logger: this.logger.child('ensure'),
      startDaemon: this.shouldStartDaemon(),
    });
    this.cachedBaseUrl = info.baseUrl;
    this.logger.debug('Daemon resolved', { baseUrl: info.baseUrl, pid: info.pid, port: info.port, started: info.started });
    return info;
  }

  /** Library-only health probe; defaults to no demand-start unlike other HTTP methods. */
  async health(options: { ensure?: boolean } = {}): Promise<unknown> {
    return this.request('GET', '/health', undefined, { ensure: options.ensure ?? false });
  }

  async createJob(input: Job | JobCreateInput, options: CreateJobOptions = {}): Promise<Job> {
    const { force, trustFolder, ...normalizeInputOptions } = options;
    const job = normalizeJobInput(input as JobCreateInput, this.normalizeOptions(normalizeInputOptions));
    this.ensureFoldersTrusted([job], trustFolder === true);
    return this.request<Job>('POST', force ? '/api/jobs?force=1' : '/api/jobs', job);
  }

  /** CLI convenience: builds a Job from raw CLI flags before delegating to createJob. Library-only. */
  async createJobFromCliOptions(input: JobCreateCliOptions): Promise<Job> {
    return this.createJob(
      buildJobFromCreateOptions(input, this.normalizeOptions({ cwd: this.options.cwd ?? process.cwd() })),
      { force: input.force, trustFolder: input.trustFolder },
    );
  }

  async listJobs(): Promise<Job[]> {
    return this.request<Job[]>('GET', '/api/jobs');
  }

  /** `id` accepts either the job's GUID id or its alias (see docs/concepts/jobs.md#identity). */
  async getJob(id: string): Promise<Job> {
    return this.request<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
  }

  /** Fetches the existing job first so the patch is applied over the current state. `id` accepts either the job's GUID id or its alias -- the daemon resolves it (see docs/concepts/jobs.md#identity). */
  async updateJob(id: string, patch: JobPatchInput, options: UpdateJobOptions = {}): Promise<Job> {
    const { trustFolder, ...normalizeInputOptions } = options;
    const existing = await this.getJob(id);
    const normalized = normalizeJobPatch(id, existing, patch, this.normalizeOptions(normalizeInputOptions));
    // Only a new folder or a different engine can change the trust answer.
    if (this.trustTarget(existing)?.key !== this.trustTarget(normalized)?.key) this.ensureFoldersTrusted([normalized], trustFolder === true);
    return this.request<Job>('PUT', `/api/jobs/${encodeURIComponent(id)}`, normalized);
  }

  /** `id` accepts either the job's GUID id or its alias. */
  async deleteJob(id?: string, options: { all?: boolean; force?: boolean } = {}): Promise<{ ok: true; canceledRun: boolean; deletedRuns: number } | { ok: true; deleted: number }> {
    if (options.all) {
      if (!options.force) throw new CrontickError('VALIDATION_ERROR', 'Deleting all jobs requires force:true');
      // Single atomic daemon call: DELETE /api/jobs wipes every job (and its
      // runs/outputs/schedule-state) in one store transaction.
      return this.request<{ ok: true; deleted: number }>('DELETE', '/api/jobs?force=1');
    }
    if (!id) throw new CrontickError('VALIDATION_ERROR', 'Provide a job id or alias, or set all:true (with force:true) to delete every job');
    return this.request<{ ok: true; canceledRun: boolean; deletedRuns: number }>('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
  }

  /** `id` accepts either the job's GUID id or its alias. */
  async enableJob(id: string): Promise<Job> {
    return this.request<Job>('POST', `/api/jobs/${encodeURIComponent(id)}/enable`);
  }

  /** `id` accepts either the job's GUID id or its alias. */
  async disableJob(id: string): Promise<Job> {
    return this.request<Job>('POST', `/api/jobs/${encodeURIComponent(id)}/disable`);
  }

  /**
   * Run a job once immediately, even when disabled. Does not enable the job or
   * touch its schedule; the overlap policy still applies. `id` accepts either
   * the job's GUID id or its alias.
   */
  async runNow(id: string): Promise<{ runId: string }> {
    return this.request<{ runId: string }>('POST', `/api/jobs/${encodeURIComponent(id)}/run`);
  }

  async cancelRun(runId: string): Promise<{ ok: true; canceled: boolean }> {
    return this.request<{ ok: true; canceled: boolean }>('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`);
  }


  /**
   * Deletes runs by `runIds` XOR `job` (id, alias, or the raw id of an already
   * deleted job). Queued/running runs are skipped and reported. `dryRun`
   * returns the same result without deleting. No confirmation prompt here.
   */
  async deleteRuns(options: { runIds?: string[]; job?: string; dryRun?: boolean }): Promise<{ deleted: string[]; skipped: Array<{ id: string; status: string }>; notFound: string[]; jobLogRemoved: boolean }> {
    const hasIds = (options.runIds?.length ?? 0) > 0;
    const hasJob = options.job !== undefined && options.job !== '';
    if (hasIds === hasJob) throw new CrontickError('VALIDATION_ERROR', 'Provide exactly one of runIds or job');
    const params = new URLSearchParams();
    if (hasIds) params.set('runId', options.runIds!.join(','));
    else params.set('jobId', options.job!);
    if (options.dryRun) params.set('dryRun', '1');
    return this.request('DELETE', `/api/runs?${params.toString()}`);
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.request<RunRecord>('GET', `/api/runs/${encodeURIComponent(runId)}`);
  }

  /** `options.jobId` accepts either the job's GUID id or its alias. */
  async listRuns(options: { jobId?: string; limit?: number; since?: number; status?: string } = {}): Promise<RunRecord[]> {
    const params = new URLSearchParams();
    if (options.jobId) params.set('jobId', options.jobId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.status !== undefined) params.set('status', options.status);
    const qs = params.toString();
    return this.request<RunRecord[]>('GET', `/api/runs${qs ? `?${qs}` : ''}`);
  }

  /**
   * Cleaned output of a run: the engine's final answer, the error (if any), and the
   * assistant's text only (segments split by tool calls are joined with `---`; no tool
   * lines, thinking or hook noise). The per-job crontick log file path is `getRun().logFile`.
   */
  async getOutput(runId: string): Promise<RunOutput> {
    return this.request<RunOutput>('GET', `/api/runs/${encodeURIComponent(runId)}/output`);
  }

  /**
   * Export jobs as a share file (`schema: 1`, jobs only, ids omitted). `onlyJobs`
   * (ids or aliases) limits the export; any unknown entry fails with
   * JOB_NOT_FOUND listing every miss.
   */
  async exportJobs(options: { onlyJobs?: string[] } = {}): Promise<ExportFile> {
    const params = new URLSearchParams();
    if (options.onlyJobs && options.onlyJobs.length > 0) params.set('jobs', options.onlyJobs.join(','));
    const qs = params.toString();
    return this.request<ExportFile>('GET', `/api/export${qs ? `?${qs}` : ''}`);
  }

  /**
   * Import jobs from a share file (`schema: 1`). The whole file is validated
   * first (a bad file imports nothing); every job gets a new GUID and an alias
   * collision gets a `-2`, `-3`, ... suffix (`renamedFrom` in the result row).
   * A job whose working directory does not exist fails on its own row; Claude
   * folder trust is checked once per distinct folder (see `trustFolder`).
   */
  async importJobs(file: unknown, options: NormalizeJobInputOptions & { trustFolder?: boolean } = {}): Promise<ImportResult> {
    const { trustFolder, ...normalizeInputOptions } = options;
    const parsed = ExportFileSchema.safeParse(file);
    if (!parsed.success) throw importFileError(file, parsed.error);
    const normalizeOptions = this.normalizeOptions(normalizeInputOptions);
    const failures: ImportResult['results'] = [];
    const jobs: Job[] = [];
    parsed.data.jobs.forEach((entry, index) => {
      const { id: _ignoredId, ...input } = entry;
      void _ignoredId;
      try {
        jobs.push(normalizeJobInput(input as JobCreateInput, normalizeOptions));
      } catch (err) {
        if (err instanceof CrontickError && err.code === 'INVALID_CWD') {
          failures.push({ id: '?', alias: entry.alias, ok: false, error: `${err.code}: jobs.${index}: ${err.message}` });
          return;
        }
        if (err instanceof CrontickError) {
          throw new CrontickError(err.code, `Invalid import file: jobs.${index}: ${err.message}`, err.details);
        }
        throw err;
      }
    });
    this.ensureFoldersTrusted(jobs, trustFolder === true);
    const applied = jobs.length > 0
      ? await this.request<ImportResult>('POST', '/api/import', { jobs })
      : { imported: 0, results: [] };
    return { imported: applied.imported, results: [...applied.results, ...failures] };
  }

  async validateSchedule(schedule: Schedule): Promise<unknown> {
    return this.request('POST', '/api/schedules/validate', ScheduleSchema.parse(schedule));
  }

  /** Library-only: preview upcoming fire times for a raw schedule object. Surfaced via jobSchedule (per-job). */
  async previewSchedule(input: { schedule: Schedule; n?: number }): Promise<unknown> {
    return this.request('POST', '/api/schedules/preview', {
      ...input,
      n: input.n ?? 5,
      schedule: ScheduleSchema.parse(input.schedule),
    });
  }

  /**
   * Show upcoming fire times for an existing job (id or alias). Resolves the
   * job, then previews the next `n` fires (default 5) of its schedule.
   */
  async jobSchedule(id: string, options: { n?: number } = {}): Promise<unknown> {
    const job = await this.getJob(id);
    const preview = await this.previewSchedule({ schedule: job.schedule, n: options.n });
    return { jobId: job.id, alias: job.alias ?? null, enabled: job.enabled, cwd: job.action.cwd ?? null, schedule: job.schedule, ...(preview as Record<string, unknown>) };
  }

  async statsSummary(): Promise<StatsSummary> {
    return this.request<StatsSummary>('GET', '/api/stats/summary');
  }

  async statsJob(id: string): Promise<JobStats> {
    return this.request<JobStats>('GET', `/api/stats/jobs/${encodeURIComponent(id)}`);
  }

  async daemonStart(options: { foreground?: boolean } = {}): Promise<DaemonStartResult> {
    const result = await startDaemon({ ...this.options, env: this.effectiveEnv(), logger: this.logger.child('lifecycle'), startDaemon: true, foreground: options.foreground });
    if (result.baseUrl) this.cachedBaseUrl = result.baseUrl;
    return result;
  }

  async daemonStop(): Promise<DaemonStopResult> {
    this.cachedBaseUrl = undefined;
    return stopDaemon({ env: this.effectiveEnv(), logger: this.logger.child('lifecycle') });
  }

  async daemonRestart(): Promise<DaemonRestartResult> {
    const result = await restartDaemon({ ...this.options, env: this.effectiveEnv(), logger: this.logger.child('lifecycle'), startDaemon: true });
    this.cachedBaseUrl = result.baseUrl;
    return result;
  }

  async daemonReload(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('POST', '/api/daemon/reload');
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>('GET', '/api/daemon/status', undefined, { ensure: false });
  }

  async doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
    return runDoctorChecks({
      daemonUrl: options.daemonUrl ?? this.options.daemonUrl,
      mcpScript: options.mcpScript ?? this.options.mcpScript,
      env: options.env ?? this.effectiveEnv(),
      checkMcpHelp: options.checkMcpHelp,
    });
  }

  async dashboardStatus(): Promise<DashboardStatus> {
    try {
      return await this.request<DashboardStatus>('GET', '/api/dashboard/status', undefined, { ensure: false });
    } catch (err) {
      if (err instanceof CrontickError && err.code === 'DAEMON_NOT_RUNNING') {
        throw dashboardDaemonDownError('dashboardStatus');
      }
      throw err;
    }
  }

  async dashboardData(options: DashboardOptions = {}): Promise<DashboardData> {
    try {
      return await this.request<DashboardData>('GET', `/api/dashboard${dashboardQuery(options)}`, undefined, { ensure: false });
    } catch (err) {
      if (err instanceof CrontickError && err.code === 'DAEMON_NOT_RUNNING') {
        throw dashboardDaemonDownError('dashboardData');
      }
      throw err;
    }
  }

  /** Returns the JSON Schema derived from Zod JobSchema. Library-only (not in surface parity). */
  jobJsonSchema(): unknown {
    return jobJsonSchema();
  }

  /**
   * Read-only environment/paths summary: crontick + node version, platform,
   * where all state is stored, and best-effort daemon running status. Never
   * starts the daemon.
   */
  async info(): Promise<CrontickInfo> {
    const env = this.effectiveEnv() ?? process.env;
    const config = this.configPath();
    let daemon: CrontickInfo['daemon'] = { running: false };
    let dashboardUrl: string | null = null;
    try {
      const status = await this.request<DaemonStatus>('GET', '/api/daemon/status', undefined, { ensure: false });
      daemon = { running: true, pid: status.pid, port: status.port, portNote: status.portNote ?? null };
      dashboardUrl = status.port ? `http://127.0.0.1:${String(status.port)}/dashboard` : null;
    } catch {
      daemon = { running: false };
      dashboardUrl = null;
    }
    return {
      version: VERSION,
      node: process.version,
      platform: process.platform,
      configPath: config.path,
      configExists: existsSync(config.path),
      paths: {
        dataDir: dataDir(env),
        jobsDir: jobsDir(env),
        runsDb: runsDbPath(env),
        logsDir: logsDir(env),
        configFile: config.path,
        portFile: portFilePath(env),
        pidFile: pidFilePath(env),
      },
      daemon,
      dashboardUrl,
    };
  }

  /**
   * Returns the config file path plus a note on how edits take effect. The
   * config file is edited directly by the user; crontick has no set/unset
   * commands. Library-friendly; surfaced directly by `info` and kept as a
   * library-only helper after the command simplification.
   */
  configPath(): ConfigPathInfo {
    return {
      path: configFilePath({ env: this.effectiveEnv() }),
      note:
        'Edit this file to change the config. Engine, logging, and per-run retention settings apply automatically on the next run; the store retention cap (retention.maxRunsPerJob) is read at daemon start, so changing it requires a daemon restart — from the CLI, run `crontick daemon stop` and then any daemon-backed command to start it again.',
    };
  }

  /** Library-only: loads config without daemon (local-only operation). */
  getConfig(): CrontickConfig {
    return redactConfigForRead(loadConfig({ env: this.effectiveEnv(), logger: this.logger.child('config') }));
  }

  getConfigValue(path?: string): unknown {
    return getConfigValue(path, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  setConfigValue(path: string, value: unknown): CrontickConfig {
    return setConfigValue(path, value, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  removeConfigValue(path: string): CrontickConfig {
    return removeConfigValue(path, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  listEngines(): Record<string, EngineConfig> {
    return listEngines({ env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  addEngine(name: string, engine: Omit<EngineConfig, 'type'> & { type?: EngineConfig['type'] }): CrontickConfig {
    return addEngine(name, engine, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  updateEngine(name: string, engine: Partial<EngineConfig>): CrontickConfig {
    return updateEngine(name, engine, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  removeEngine(name: string): CrontickConfig {
    return removeEngine(name, { env: this.effectiveEnv(), logger: this.logger.child('config') });
  }

  initConfig(options: { force?: boolean } = {}): { path: string; config: CrontickConfig; created: boolean } {
    return initConfig({ env: this.effectiveEnv(), logger: this.logger.child('config'), force: options.force });
  }

  validateConfig(path?: string): ConfigValidationResult {
    return validateConfigFile({ env: this.effectiveEnv(), logger: this.logger.child('config'), path });
  }

  /** Drains accumulated normalization notices (e.g. promptFile read). Library-only. */
  drainNotices(): string[] {
    const drained = this.notices;
    this.notices = [];
    return drained;
  }

  /** Library-only verbose accessor. */
  isVerbose(): boolean {
    return this.verbose;
  }

  /**
   * Central HTTP transport. On network error with auto-start allowed, clears
   * the cached URL, re-ensures the daemon (demand-start), waits 100 ms, and
   * retries once. Non-2xx responses are translated to CrontickError using the
   * code/message from the daemon response body.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { ensure?: boolean } = {},
  ): Promise<T> {
    const ensure = options.ensure ?? true;
    const baseUrl = await this.baseUrl({ ensure });
    let res: HttpTextResponse;
    const startedAt = Date.now();
    this.logger.debug('HTTP request', { method, path, baseUrl, ensure });
    try {
      res = await this.fetchRequest(baseUrl, method, path, body);
    } catch (err) {
      // No retry when: ensure disabled, startDaemon off, or explicit daemonUrl (user-managed).
      if (!ensure || !this.shouldStartDaemon() || this.options.daemonUrl) {
        this.logger.debug('HTTP request failed without retry', { method, path, baseUrl, error: errorMessage(err), durationMs: Date.now() - startedAt });
        throw this.daemonRequestError(baseUrl, method, path, err);
      }
      this.cachedBaseUrl = undefined;
      this.logger.debug('HTTP request failed; retrying after daemon ensure', { method, path, baseUrl, error: errorMessage(err) });
      const restarted = await this.ensure();
      await boundedBackoff();
      try {
        res = await this.fetchRequest(restarted.baseUrl, method, path, body);
      } catch (retryErr) {
        this.logger.debug('HTTP retry failed', { method, path, baseUrl: restarted.baseUrl, error: errorMessage(retryErr), durationMs: Date.now() - startedAt });
        throw this.daemonRequestError(restarted.baseUrl, method, path, retryErr);
      }
    }
    const text = res.text;
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new CrontickError('PARSE_ERROR', `Unexpected response: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new CrontickError(
        err?.code ?? 'API_ERROR',
        err?.message ?? `HTTP ${res.status}`,
        err?.details,
      );
    }
    this.logger.debug('HTTP response', { method, path, baseUrl, status: res.status, durationMs: Date.now() - startedAt });
    return data as T;
  }

  /** Resolves base URL: ensure=true triggers full demand-start; false reads cache/port file only. */
  private async baseUrl(options: { ensure: boolean }): Promise<string> {
    if (options.ensure) {
      return (await this.ensure()).baseUrl;
    }
    if (this.cachedBaseUrl) return this.cachedBaseUrl;
    const baseUrl = await resolveDaemonBaseUrl({
      daemonUrl: this.options.daemonUrl,
      env: this.effectiveEnv(),
      logger: this.logger.child('ensure'),
    });
    this.cachedBaseUrl = baseUrl;
    return baseUrl;
  }

  /** `engine|cwd` identity of what the trust check applies to, or undefined when the job's engine has no trust concept. */
  private trustTarget(job: Job): { key: string; cwd: string; engine: string; adapter: ReturnType<typeof getEngineAdapter> } | undefined {
    if (job.action.kind !== 'prompt') return undefined;
    const config = loadConfig({ env: this.effectiveEnv() });
    const engine = job.action.engine ?? config.defaultEngine;
    const engineConfig = config.engines[engine];
    if (!engineConfig) return undefined;
    const adapter = getEngineAdapter(engineConfig.type);
    if (!adapter.isFolderTrusted || !adapter.trustFolder) return undefined;
    const cwd = job.action.cwd ?? this.options.cwd ?? process.cwd();
    return { key: `${engine}|${cwd}`, cwd, engine, adapter };
  }

  /**
   * Claude folder trust guardrail (engines without trust hooks are skipped).
   * Untrusted folders throw TRUST_REQUIRED before anything is persisted, unless
   * `trustFolder` is true, in which case they are trusted first. Distinct
   * folders are checked once each; details.folders lists every untrusted one.
   */
  private ensureFoldersTrusted(jobs: Job[], trustFolder: boolean): void {
    const env = this.effectiveEnv() ?? process.env;
    const untrusted = new Map<string, NonNullable<ReturnType<CrontickClient['trustTarget']>>>();
    for (const job of jobs) {
      const target = this.trustTarget(job);
      if (!target || untrusted.has(target.cwd)) continue;
      if (!target.adapter.isFolderTrusted!(target.cwd, { env })) untrusted.set(target.cwd, target);
    }
    if (untrusted.size === 0) return;
    const targets = [...untrusted.values()];
    if (!trustFolder) {
      const folders = targets.map((target) => target.cwd);
      const subject = folders.length === 1 ? `Folder ${folders[0]} is not` : `Folders ${folders.join(', ')} are not`;
      throw new CrontickError(
        'TRUST_REQUIRED',
        `${subject} trusted by Claude. Re-run with --trust-folder (CLI) or trustFolder: true (library/MCP) to trust ${folders.length === 1 ? 'it' : 'them'}. Agents: ask the user for permission first, then call again with trustFolder: true.`,
        { cwd: folders[0], folders, engine: targets[0]!.engine },
      );
    }
    for (const target of targets) target.adapter.trustFolder!(target.cwd, { env });
  }

  private normalizeOptions(options: NormalizeJobInputOptions): NormalizeJobInputOptions {
    return {
      cwd: this.options.cwd,
      env: this.effectiveEnv(),
      ...options,
      onNotice: (message) => {
        this.notices.push(message);
        options.onNotice?.(message);
      },
    };
  }

  private shouldStartDaemon(): boolean {
    return this.options.startDaemon ?? true;
  }

  /** Propagates verbose flag into the env so spawned daemon inherits it. */
  private effectiveEnv(): NodeJS.ProcessEnv | undefined {
    const source = this.options.env;
    if (!this.verbose) return source;
    return { ...(source ?? process.env), CRONTICK_VERBOSE: '1' };
  }

  private fetchRequest(
    baseUrl: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<HttpTextResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Connection: 'close',
        // Always sent: the daemon's request guard requires it on every mutating request, bodyless included.
        'Content-Type': 'application/json',
      };
      if (payload !== undefined) {
        headers['Content-Length'] = String(Buffer.byteLength(payload));
      }

      let settled = false;
      const finish = <T>(action: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        action(value);
      };

      const req = http.request(url, { method, headers, agent: false }, (res) => {
        res.setEncoding('utf8');
        const chunks: string[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          finish(resolve, {
            status,
            ok: status >= 200 && status < 300,
            text: chunks.join(''),
          });
        });
        res.on('aborted', () => finish(reject, new Error('Response aborted before completion')));
        res.on('error', (err) => finish(reject, err));
      });

      const timeout = setTimeout(() => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      req.on('error', (err) => finish(reject, err));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private daemonRequestError(baseUrl: string, method: string, path: string, err: unknown): CrontickError {
    return new CrontickError(
      'DAEMON_REQUEST_FAILED',
      `Failed to reach the crontick daemon at ${baseUrl}${path} while attempting ${method}: ${errorMessage(err)}. crontick attempted a demand-start/reconnect when allowed. Run "crontick daemon start" and inspect the daemon ensure log under the crontick data directory logs folder if this continues.`,
      { baseUrl, method, path },
    );
  }
}

/** Factory used by all three surfaces (CLI, MCP, library) to instantiate the client. */
export function createClient(options?: CrontickClientOptions): CrontickClient {
  return new CrontickClient(options);
}

/** Fixed 100 ms backoff between demand-start and first retry — enough for port file flush. */
async function boundedBackoff(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Maps a failed export-file parse to a VALIDATION_ERROR naming the offending path (nothing is imported). */
function importFileError(file: unknown, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): CrontickError {
  const problems = error.issues.slice(0, 10).map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'}: ${issue.message}`);
  const hint = Array.isArray(file)
    ? ' A bare array is not supported; use a file written by `crontick share export` (an object with "schema": 1 and "jobs").'
    : typeof file === 'object' && file !== null && !('schema' in file)
      ? ' The file has no "schema" field; use a file written by `crontick share export` (schema 1).'
      : '';
  return new CrontickError('VALIDATION_ERROR', `Invalid import file: ${problems.join('; ')}.${hint} Nothing was imported.`, { issues: problems });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dashboardQuery(options: DashboardOptions): string {
  const params = new URLSearchParams();
  if (options.jobId) params.set('jobId', options.jobId);
  if (options.runsLimit !== undefined) params.set('runsLimit', String(options.runsLimit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
