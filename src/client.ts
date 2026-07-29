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
import { CrontickError } from './errors.js';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDaemon,
  resolveDaemonBaseUrl,
  type DaemonInfo,
  type EnsureDaemonOptions,
} from './daemon/ensure.js';
import { restartDaemon, startDaemon, stopDaemon, type DaemonRestartResult, type DaemonStartResult, type DaemonStopResult } from './daemon/lifecycle.js';
import { ScheduleSchema, type Job, type Schedule } from './schemas/job.js';
import {
  buildJobFromCreateOptions,
  normalizeJobInput,
  normalizeJobPatch,
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
  type DashboardStartResult,
  type DashboardStatus,
  type DashboardStopResult,
} from './dashboard.js';
import {
  addEngine,
  getConfigValue,
  initConfig,
  listEngines,
  loadConfig,
  removeConfigValue,
  removeEngine,
  setConfigValue,
  updateEngine,
  validateConfigFile,
  type ConfigValidationResult,
  type CrontickConfig,
  type EngineConfig,
} from './config.js';
import { createLogger, isVerboseEnv, type Logger, type LogSink } from './logger.js';

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

export interface LogEntry {
  runId?: string;
  stream: string;
  ts: number;
  data: string;
}

export interface LogsResult {
  runId: string;
  lines: LogEntry[];
}

export interface StatsSummary {
  totalJobs: number;
  enabledJobs: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
}

export interface JobStats {
  jobId: string;
  totalRuns: number;
  succeeded: number;
  failed: number;
  lastStatus: string | null;
  lastRunAt: number | null;
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
    const { force, ...normalizeInputOptions } = options;
    const job = normalizeJobInput(input as JobCreateInput, this.normalizeOptions(normalizeInputOptions));
    return this.request<Job>('POST', force ? '/api/jobs?force=1' : '/api/jobs', job);
  }

  /** CLI convenience: builds a Job from raw CLI flags before delegating to createJob. Library-only. */
  async createJobFromCliOptions(input: JobCreateCliOptions): Promise<Job> {
    return this.createJob(
      buildJobFromCreateOptions(input, this.normalizeOptions({ cwd: this.options.cwd ?? process.cwd() })),
      { force: input.force },
    );
  }

  async listJobs(): Promise<Job[]> {
    return this.request<Job[]>('GET', '/api/jobs');
  }

  async getJob(id: string): Promise<Job> {
    return this.request<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
  }

  /** Fetches the existing job first so the patch is applied over the current state. */
  async updateJob(id: string, patch: JobPatchInput, options: NormalizeJobInputOptions = {}): Promise<Job> {
    const existing = await this.getJob(id);
    const normalized = normalizeJobPatch(id, existing, patch, this.normalizeOptions(options));
    return this.request<Job>('PUT', `/api/jobs/${encodeURIComponent(id)}`, normalized);
  }

  async deleteJob(id: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
  }

  async enableJob(id: string): Promise<Job> {
    return this.request<Job>('POST', `/api/jobs/${encodeURIComponent(id)}/enable`);
  }

  async disableJob(id: string): Promise<Job> {
    return this.request<Job>('POST', `/api/jobs/${encodeURIComponent(id)}/disable`);
  }

  async runNow(id: string): Promise<{ runId: string }> {
    return this.request<{ runId: string }>('POST', `/api/jobs/${encodeURIComponent(id)}/run`);
  }

  async cancelRun(runId: string): Promise<{ ok: true; canceled: boolean }> {
    return this.request<{ ok: true; canceled: boolean }>('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async getRun(runId: string): Promise<unknown> {
    return this.request('GET', `/api/runs/${encodeURIComponent(runId)}`);
  }

  async listRuns(options: { jobId?: string; limit?: number; since?: number; status?: string } = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (options.jobId) params.set('jobId', options.jobId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.status !== undefined) params.set('status', options.status);
    const qs = params.toString();
    return this.request<unknown[]>('GET', `/api/runs${qs ? `?${qs}` : ''}`);
  }

  async getLogs(runId: string, options: { lines?: number } = {}): Promise<LogsResult> {
    const logs = await this.request<LogEntry[]>('GET', `/api/runs/${encodeURIComponent(runId)}/logs`);
    const lines = options.lines !== undefined ? logs.slice(-options.lines) : logs;
    return { runId, lines };
  }

  async exportJobs(options: { includeRuns?: boolean } = {}): Promise<{ jobs: Job[]; runs?: unknown[] }> {
    return this.request('GET', `/api/export${options.includeRuns ? '?includeRuns=1' : ''}`);
  }

  async importJobs(jobs: unknown[], options: NormalizeJobInputOptions & { runs?: unknown[] } = {}): Promise<unknown> {
    const normalized = jobs.map((job) => normalizeJobInput(job as JobCreateInput, this.normalizeOptions(options)));
    return this.request('POST', '/api/import', { jobs: normalized, runs: options.runs });
  }

  async validateSchedule(schedule: Schedule): Promise<unknown> {
    return this.request('POST', '/api/schedules/validate', ScheduleSchema.parse(schedule));
  }

  async previewSchedule(input: { schedule: Schedule; n?: number; tz?: string }): Promise<unknown> {
    return this.request('POST', '/api/schedules/preview', {
      ...input,
      n: input.n ?? 5,
      schedule: ScheduleSchema.parse(input.schedule),
    });
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

  async daemonStatus(): Promise<unknown> {
    return this.request('GET', '/api/daemon/status', undefined, { ensure: false });
  }

  async doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
    return runDoctorChecks({
      daemonUrl: options.daemonUrl ?? this.options.daemonUrl,
      mcpScript: options.mcpScript ?? this.options.mcpScript,
      env: options.env ?? this.effectiveEnv(),
      checkMcpHelp: options.checkMcpHelp,
    });
  }

  async dashboardStart(): Promise<DashboardStartResult> {
    const info = await this.ensure();
    const status = await this.request<DashboardStatus>('GET', '/api/dashboard/status', undefined, { ensure: false });
    return { ...status, startedDaemon: info.started };
  }

  async dashboardStop(): Promise<DashboardStopResult> {
    return this.daemonStop();
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

  /** Library-only: loads config without daemon (local-only operation). */
  getConfig(): CrontickConfig {
    return loadConfig({ env: this.effectiveEnv(), logger: this.logger.child('config') });
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

  addEngine(name: string, engine: EngineConfig): CrontickConfig {
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
    let res: Response;
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
    const text = await res.text();
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
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
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
