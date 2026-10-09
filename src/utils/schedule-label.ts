import { isTimeSchedule, type Schedule } from '../schemas/job.js';
import { redactRelayUrl } from './webhook-redact.js';

/** Minimal upstream info needed to label an `after` schedule. */
export interface ScheduleLabelTarget {
  alias?: string | null;
}

/** Resolves an upstream job GUID to its (optional) alias; undefined when the job no longer exists. */
export type ScheduleLabelLookup = (jobId: string) => ScheduleLabelTarget | undefined;

/** Human-readable schedule label shared by CLI, MCP and dashboard. */
export function describeSchedule(schedule: Schedule, lookup: ScheduleLabelLookup, catchUp = false): string {
  const label = describeBase(schedule, lookup);
  return catchUp && isTimeSchedule(schedule) ? `${label} (catch-up)` : label;
}

function describeBase(schedule: Schedule, lookup: ScheduleLabelLookup): string {
  if (schedule.kind === 'cron') return schedule.cron;
  if (schedule.kind === 'interval') return `every ${schedule.everySec}s`;
  if (schedule.kind === 'after') {
    const upstream = lookup(schedule.jobId);
    const id8 = schedule.jobId.slice(0, 8);
    if (!upstream) return `after ${id8} (missing)`;
    return `after ${upstream.alias || id8} (on ${schedule.status})`;
  }
  if (schedule.kind === 'webhook') return schedule.relay ? `webhook (relay: ${redactRelayUrl(schedule.relay)})` : 'webhook (local only)';
  return `once at ${schedule.runAt}`;
}
