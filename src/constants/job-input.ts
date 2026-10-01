/**
 * Job-input normalization defaults. Centralized here (design-principles.md
 * #3) for `src/job-input.ts`.
 */

/** Default max bytes read from a `promptFile` before `normalizeJobInput()` rejects it. */
export const DEFAULT_MAX_PROMPT_FILE_BYTES = 1024 * 1024;
