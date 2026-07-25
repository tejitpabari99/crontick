import { CrontickError } from './errors.js';
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
import { uninstall, type UninstallResult } from './uninstall.js';

export interface CrontickClientOptions extends Omit<EnsureDaemonOptions, 'startDaemon'> {
  requestTimeoutMs?: number;
  cwd?: string;
  startDaemon?: boolean;
  mcpScript?: string;
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
  private cachedBaseUrl?: string;
  private notices: string[] = [];

  constructor(options: CrontickClientOptions = {}) {
    this.options = options;
  }

  async ensure(): Promise<DaemonInfo> {
    const info = await ensureDaemon({
      ...this.options,
      startDaemon: this.shouldStartDaemon(),
    });
    this.cachedBaseUrl = info.baseUrl;
    return info;
  }

  async health(options: { ensure?: boolean } = {}): Promise<unknown> {
    return this.request('GET', '/health', undefined, { ensure: options.ensure ?? false });
  }

  async createJob(input: Job | JobCreateInput, options: NormalizeJobInputOptions = {}): Promise<Job> {
    const job = normalizeJobInput(input as JobCreateInput, this.normalizeOptions(options));
    return this.request<Job>('POST', '/api/jobs', job);
  }

  async createJobFromCliOptions(input: JobCreateCliOptions): Promise<Job> {
    return this.createJob(buildJobFromCreateOptions(input, this.normalizeOptions({ cwd: this.options.cwd ?? process.cwd() })));
  }

  async listJobs(): Promise<Job[]> {
    return this.request<Job[]>('GET', '/api/jobs');
  }

  async getJob(id: string): Promise<Job> {
    return this.request<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
  }

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

  async listRuns(options: { jobId?: string; limit?: number; since?: number } = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (options.jobId) params.set('jobId', options.jobId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.since !== undefined) params.set('since', String(options.since));
    const qs = params.toString();
    return this.request<unknown[]>('GET', `/api/runs${qs ? `?${qs}` : ''}`);
  }

  async getLogs(runId: string, options: { lines?: number } = {}): Promise<LogsResult> {
    const logs = await this.request<LogEntry[]>('GET', `/api/runs/${encodeURIComponent(runId)}/logs`);
    const lines = options.lines !== undefined ? logs.slice(-options.lines) : logs;
    return { runId, lines };
  }

  async exportJobs(): Promise<{ jobs: Job[] }> {
    return this.request<{ jobs: Job[] }>('GET', '/api/export');
  }

  async importJobs(jobs: unknown[], options: NormalizeJobInputOptions = {}): Promise<unknown> {
    const normalized = jobs.map((job) => normalizeJobInput(job as JobCreateInput, this.normalizeOptions(options)));
    return this.request('POST', '/api/import', { jobs: normalized });
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
    const result = await startDaemon({ ...this.options, startDaemon: true, foreground: options.foreground });
    if (result.baseUrl) this.cachedBaseUrl = result.baseUrl;
    return result;
  }

  async daemonStop(): Promise<DaemonStopResult> {
    this.cachedBaseUrl = undefined;
    return stopDaemon({ env: this.options.env });
  }

  async daemonRestart(): Promise<DaemonRestartResult> {
    const result = await restartDaemon({ ...this.options, startDaemon: true });
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
      env: options.env ?? this.options.env,
      checkMcpHelp: options.checkMcpHelp,
    });
  }

  async dashboardUrl(options: { open?: false } = {}): Promise<string> {
    void options;
    const baseUrl = await this.baseUrl({ ensure: true });
    return `${baseUrl}/dashboard`;
  }

  jobJsonSchema(): unknown {
    return jobJsonSchema();
  }

  async uninstall(options: { purge?: boolean } = {}): Promise<UninstallResult> {
    return uninstall({ purge: options.purge, env: this.options.env });
  }

  drainNotices(): string[] {
    const drained = this.notices;
    this.notices = [];
    return drained;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { ensure?: boolean } = {},
  ): Promise<T> {
    const ensure = options.ensure ?? true;
    const baseUrl = await this.baseUrl({ ensure });
    let res: Response;
    try {
      res = await this.fetchRequest(baseUrl, method, path, body);
    } catch (err) {
      if (!ensure || !this.shouldStartDaemon() || this.options.daemonUrl) {
        throw this.daemonRequestError(method, path, err);
      }
      this.cachedBaseUrl = undefined;
      const restarted = await this.ensure();
      await boundedBackoff();
      try {
        res = await this.fetchRequest(restarted.baseUrl, method, path, body);
      } catch (retryErr) {
        throw this.daemonRequestError(method, path, retryErr);
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
    return data as T;
  }

  private async baseUrl(options: { ensure: boolean }): Promise<string> {
    if (options.ensure) {
      return (await this.ensure()).baseUrl;
    }
    if (this.cachedBaseUrl) return this.cachedBaseUrl;
    const baseUrl = await resolveDaemonBaseUrl({
      daemonUrl: this.options.daemonUrl,
      env: this.options.env,
    });
    this.cachedBaseUrl = baseUrl;
    return baseUrl;
  }

  private normalizeOptions(options: NormalizeJobInputOptions): NormalizeJobInputOptions {
    return {
      cwd: this.options.cwd,
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

  private daemonRequestError(method: string, path: string, err: unknown): CrontickError {
    return new CrontickError(
      'DAEMON_REQUEST_FAILED',
      `Failed to reach the crontick daemon while attempting ${method} ${path}: ${errorMessage(err)}. crontick attempted a demand-start/reconnect when allowed. Run "crontick daemon start" and inspect the daemon ensure log under the crontick data directory logs folder if this continues.`,
      { method, path },
    );
  }
}

export function createClient(options?: CrontickClientOptions): CrontickClient {
  return new CrontickClient(options);
}

async function boundedBackoff(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
