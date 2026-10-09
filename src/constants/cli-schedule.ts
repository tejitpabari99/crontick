/**
 * Schedule flags shown by the CLI (`jobs new` / `jobs update`). Append new
 * schedule kinds here; option help and the `jobs new` footer derive from it.
 */
export interface ScheduleFlag {
  readonly flag: string;
  readonly arg: string;
  readonly description: string;
}

export const SCHEDULE_FLAGS: readonly ScheduleFlag[] = [
  { flag: '--cron', arg: '<expr>', description: 'Schedule: cron expression, e.g. "0 9 * * *"' },
  { flag: '--every', arg: '<interval>', description: 'Schedule: repeat every N seconds, or use an s/m/h/d suffix (e.g. 30m)' },
  { flag: '--at', arg: '<datetime>', description: 'Schedule: one-shot run time, ISO-8601 (e.g. 2026-10-01T09:00)' },
];

/** After-help footer for `jobs new`, generated from SCHEDULE_FLAGS. */
export function scheduleFooter(flags: readonly ScheduleFlag[] = SCHEDULE_FLAGS): string {
  return `\nHow to schedule:\n  Use exactly one of ${flags.map((f) => f.flag).join(', ')}.\n`;
}
