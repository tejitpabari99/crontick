/**
 * Single `sleep(ms)` helper shared across the daemon (design-principles.md
 * #2 -- work modular), used by `src/daemon/lifecycle.ts`, `src/daemon/ensure.ts`, and `src/daemon/runner.ts`.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
