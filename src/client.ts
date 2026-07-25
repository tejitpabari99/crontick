import { CrontickError } from './errors.js';
import {
  ensureDaemon,
  resolveDaemonBaseUrl,
  type DaemonInfo,
  type EnsureDaemonOptions,
} from './daemon/ensure.js';
import {
  JobSchema,
  ScheduleSchema,
  type Job,
  type JobInput,
  type Schedule,
} from './schemas/job.js';

export interface CrontickClientOptions extends EnsureDaemonOptions {
  autoStart?: boolean;
  requestTimeoutMs?: number;
  cwd?: string;
}

export class CrontickClient {
  private readonly options: CrontickClientOptions;
  private cachedBaseUrl?: string;

  constructor(options: CrontickClientOptions = {}) {
    this.options = options;
  }

  async ensure(): Promise<DaemonInfo> {
    const info = await ensureDaemon({
      ...this.options,
      allowStart: this.options.autoStart ?? this.options.allowStart ?? true,
    });
    this.cachedBaseUrl = info.baseUrl;
    return info;
  }

  async health(options: { ensure?: boolean } = {}): Promise<unknown> {
    return this.request('GET', '/health', undefined, { ensure: options.ensure ?? false });
  }

  async createJob(input: Job | JobInput): Promise<Job> {
    const job = JobSchema.parse(input);
    return this.request<Job>('POST', '/api/jobs', job);
  }

  async listJobs(): Promise<Job[]> {
    return this.request<Job[]>('GET', '/api/jobs');
  }

  async getJob(id: string): Promise<Job> {
    return this.request<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
  }

  async updateJob(id: string, patch: Partial<JobInput>): Promise<Job> {
    return this.request<Job>('PUT', `/api/jobs/${encodeURIComponent(id)}`, patch);
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

  async getLogs(runId: string): Promise<Array<{ stream: string; ts: number; data: string }>> {
    return this.request<Array<{ stream: string; ts: number; data: string }>>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/logs`,
    );
  }

  async exportJobs(): Promise<{ jobs: Job[] }> {
    return this.request<{ jobs: Job[] }>('GET', '/api/export');
  }

  async importJobs(jobs: unknown[]): Promise<unknown> {
    const normalized = jobs.map((job) => JobSchema.parse(job));
    return this.request('POST', '/api/import', { jobs: normalized });
  }

  async validateSchedule(schedule: Schedule): Promise<unknown> {
    return this.request('POST', '/api/schedules/validate', ScheduleSchema.parse(schedule));
  }

  async previewSchedule(input: { schedule: Schedule; n?: number; tz?: string }): Promise<unknown> {
    return this.request('POST', '/api/schedules/preview', {
      ...input,
      schedule: ScheduleSchema.parse(input.schedule),
    });
  }

  async daemonReload(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('POST', '/api/daemon/reload');
  }

  async daemonStatus(): Promise<unknown> {
    return this.request('GET', '/api/daemon/status', undefined, { ensure: false });
  }

  async dashboardUrl(options: { open?: false } = {}): Promise<string> {
    void options;
    const baseUrl = await this.baseUrl({ ensure: true });
    return `${baseUrl}/dashboard`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { ensure?: boolean } = {},
  ): Promise<T> {
    const baseUrl = await this.baseUrl({ ensure: options.ensure ?? true });
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
    });
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
    const baseUrl = await resolveDaemonBaseUrl({ daemonUrl: this.options.daemonUrl });
    this.cachedBaseUrl = baseUrl;
    return baseUrl;
  }
}

export function createClient(options?: CrontickClientOptions): CrontickClient {
  return new CrontickClient(options);
}
