/**
 * Human-readable formatting for run records (used by `crontick runs list`).
 * Pure functions with no I/O so they are trivially testable; the CLI shim only
 * prints the result. Machine consumers use the raw records (`--json`).
 */
import type { RunRecord } from './client.js';

/** Longest error text shown in the table before it is truncated (full text is in `--json` / `runs get`). */
export const RUN_TABLE_ERROR_MAX = 60;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms -> ISO-8601 in the machine's local timezone with offset, e.g. `2026-09-29T04:04:19+02:00`. */
export function formatLocalIso(epochMs: number | undefined): string {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return '-';
  const d = new Date(epochMs);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Milliseconds -> seconds text with up to 2 decimals, e.g. `12.3s`; `-` when unknown. */
export function formatDurationSec(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '-';
  return `${Number((ms / 1000).toFixed(2))}s`;
}

/** Collapse whitespace and truncate to `max` characters with an ellipsis. */
export function truncateText(text: string | undefined, max = RUN_TABLE_ERROR_MAX): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render runs as an aligned table: id, job, status, local start/end times, duration in seconds, exit code, truncated error. */
export function formatRunsTable(runs: readonly RunRecord[]): string {
  const header = ['RUN', 'JOB', 'STATUS', 'STARTED', 'ENDED', 'DURATION', 'EXIT', 'ERROR'];
  const rows = runs.map((run) => [
    run.id,
    run.jobId,
    run.status,
    formatLocalIso(run.startedAt),
    formatLocalIso(run.endedAt),
    formatDurationSec(run.durationMs),
    run.exitCode === undefined ? '-' : String(run.exitCode),
    truncateText(run.error),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]): string => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
