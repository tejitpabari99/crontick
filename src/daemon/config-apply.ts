// Daemon-side "apply config with an in-flight run policy" flow (SP03 R16).
// `stop`: cancel every in-flight run, then apply + reload. `wait`: pause the
// scheduler, wait (no timeout) for in-flight runs to finish, apply + reload,
// then resume automatically. No choice with runs in flight is an error.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, type ApplyOpsOptions, type ApplyOpsResult, type ConfigOp } from '../config.js';
import { IN_FLIGHT_CHOICES, PENDING_CONFIG_APPLY_FILE } from '../constants/config.js';
import { CrontickError } from '../errors.js';
import type { InFlightRun, Runner } from './runner.js';
import type { Scheduler } from './scheduler.js';

export type InFlightChoice = (typeof IN_FLIGHT_CHOICES)[number];

export interface ConfigApplyDeps {
  runner: Pick<Runner, 'listInFlight' | 'cancelAllInFlight' | 'waitForIdle'>;
  scheduler: Pick<Scheduler, 'pause' | 'resume' | 'isPaused'>;
  /** Reloads jobs/config into the live daemon (never disturbs running runs). */
  reload: () => Promise<void>;
  /** Directory holding the pending-wait marker (the daemon data dir). */
  dataDir: string;
  /** Injectable for tests; defaults to the real locked writer. */
  applyOps?: (ops: ConfigOp[], options: ApplyOpsOptions) => Promise<ApplyOpsResult>;
  now?: () => number;
}

export interface ConfigApplyRequest {
  ops: ConfigOp[];
  ifRevision?: string;
  inFlight?: InFlightChoice;
}

export interface ConfigApplyResult extends ApplyOpsResult {
  /** Policy that was actually used: `none` when nothing was in flight. */
  inFlightPolicy: 'none' | InFlightChoice;
  /** Runs that were in flight when the save started. */
  affectedRuns: InFlightRun[];
}

export interface LostPendingConfigApply {
  startedAt: number;
  keys: string[];
  runIds: string[];
}

function markerPath(dir: string): string {
  return join(dir, PENDING_CONFIG_APPLY_FILE);
}

/**
 * Read and remove a pending-wait marker left by a previous daemon session.
 * Returns it when found (the wait-then-apply was lost with the restart), else null.
 */
export function consumeLostPendingConfigApply(dir: string): LostPendingConfigApply | null {
  const file = markerPath(dir);
  if (!existsSync(file)) return null;
  let parsed: LostPendingConfigApply | null = null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LostPendingConfigApply>;
    parsed = {
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      keys: Array.isArray(raw.keys) ? raw.keys.map(String) : [],
      runIds: Array.isArray(raw.runIds) ? raw.runIds.map(String) : [],
    };
  } catch {
    parsed = { startedAt: 0, keys: [], runIds: [] };
  }
  rmSync(file, { force: true });
  return parsed;
}

function describeRuns(runs: InFlightRun[]): string {
  return runs.map((r) => `${r.jobId} (run ${r.runId})`).join(', ');
}

export async function applyConfigWithPolicy(deps: ConfigApplyDeps, req: ConfigApplyRequest): Promise<ConfigApplyResult> {
  if (req.inFlight !== undefined && !IN_FLIGHT_CHOICES.includes(req.inFlight)) {
    throw new CrontickError('INVALID_IN_FLIGHT_CHOICE', `inFlight must be one of: ${IN_FLIGHT_CHOICES.join(', ')}`, { inFlight: req.inFlight });
  }
  const apply = deps.applyOps ?? applyOps;
  const applyOptions: ApplyOpsOptions = {
    // This code runs inside the daemon, so the daemon is by definition running.
    daemonRunning: () => true,
    ...(req.ifRevision !== undefined ? { ifRevision: req.ifRevision } : {}),
  };
  const finish = async (policy: ConfigApplyResult['inFlightPolicy'], affected: InFlightRun[]): Promise<ConfigApplyResult> => {
    const result = await apply(req.ops, applyOptions);
    await deps.reload();
    return { ...result, inFlightPolicy: policy, affectedRuns: affected };
  };

  const inFlight = deps.runner.listInFlight();
  if (inFlight.length === 0) return finish('none', []);

  if (req.inFlight === undefined) {
    throw new CrontickError(
      'RUNS_IN_FLIGHT',
      `Runs are in flight: ${describeRuns(inFlight)}. Choose inFlight "stop" (cancel them, then apply) or "wait" (pause, let them finish, then apply and resume).`,
      { runs: inFlight },
    );
  }

  // Hold the scheduler so no new run starts between draining and applying.
  const wasPaused = deps.scheduler.isPaused();
  deps.scheduler.pause();
  const marker = markerPath(deps.dataDir);
  try {
    if (req.inFlight === 'stop') {
      await deps.runner.cancelAllInFlight();
    } else {
      const pending: LostPendingConfigApply = {
        startedAt: (deps.now ?? Date.now)(),
        keys: req.ops.map((o) => o.key),
        runIds: inFlight.map((r) => r.runId),
      };
      mkdirSync(deps.dataDir, { recursive: true });
      writeFileSync(marker, JSON.stringify(pending), 'utf-8');
      await deps.runner.waitForIdle();
    }
    return await finish(req.inFlight, inFlight);
  } finally {
    rmSync(marker, { force: true });
    // Only undo a pause this flow introduced; a user-requested pause stays.
    if (!wasPaused) deps.scheduler.resume();
  }
}
