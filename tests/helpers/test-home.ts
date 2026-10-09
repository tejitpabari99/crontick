import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write `<dir>/config.json` with `daemon.port` 0 so a real daemon spawned in this
 * CRONTICK_HOME takes an OS-assigned free port instead of contending for 47615.
 * `extra` is merged at the top level; its `daemon` keys are merged over the default.
 * Omitting the call degrades to the default port with fallback (slower, noisier), not a failure.
 */
export function writeTestConfig(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  const daemon = { port: 0, ...((extra['daemon'] as Record<string, unknown> | undefined) ?? {}) };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...extra, daemon }, null, 2));
}
