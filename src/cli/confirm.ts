/**
 * Generic y/N confirmation for destructive CLI commands, modeled on
 * trust-prompt.ts: streams are injectable so it is testable without a TTY.
 * The decision of WHAT to delete lives in the client; this shim only previews
 * (via a dry run), asks the human, and repeats the call for real.
 */
import { CrontickError } from '../errors.js';
import type { CrontickClient } from '../client.js';
import { terminalTrustPromptIo, type TrustPromptIo } from './trust-prompt.js';

export type ConfirmIo = TrustPromptIo;
export const terminalConfirmIo = terminalTrustPromptIo;

/** Asks `question`; true only for `y`/`yes` (case-insensitive). */
export async function confirm(question: string, io: ConfirmIo): Promise<boolean> {
  const answer = (await io.ask(question)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export interface DeleteRunsCliOptions {
  runIds?: string[];
  job?: string;
  force?: boolean;
  dryRun?: boolean;
}

type DeleteRunsClient = Pick<CrontickClient, 'deleteRuns'>;
type DeleteRunsResult = Awaited<ReturnType<CrontickClient['deleteRuns']>>;

/**
 * `--dry-run`: preview only. `--force`: delete without asking. Otherwise
 * dry-run, show the count, ask `Delete N run(s)[ of job X]? (y/N)`, then delete.
 * Non-interactive without `--force` throws CONFIRMATION_REQUIRED.
 */
export async function deleteRunsWithConfirm(client: DeleteRunsClient, options: DeleteRunsCliOptions, io: ConfirmIo): Promise<DeleteRunsResult> {
  const target = options.job !== undefined ? { job: options.job } : { runIds: options.runIds };
  if (options.dryRun) return client.deleteRuns({ ...target, dryRun: true });
  if (options.force) return client.deleteRuns({ ...target, dryRun: false });
  if (!io.interactive) {
    throw new CrontickError('CONFIRMATION_REQUIRED', 'Deleting runs needs confirmation; re-run with --force (or --dry-run to preview).');
  }
  const preview = await client.deleteRuns({ ...target, dryRun: true });
  if (preview.deleted.length > 0) {
    const question = `Delete ${preview.deleted.length} run(s)${options.job !== undefined ? ` of job ${options.job}` : ''}? (y/N) `;
    if (!(await confirm(question, io))) {
      throw new CrontickError('CONFIRMATION_DECLINED', 'Not confirmed; nothing was deleted.');
    }
  }
  return client.deleteRuns({ ...target, dryRun: false });
}

/** Plain-text summary line for `runs delete`. */
export function formatDeleteRunsSummary(result: DeleteRunsResult, dryRun: boolean): string {
  return `${dryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} run(s); skipped ${result.skipped.length} active; not found ${result.notFound.length}.`;
}
