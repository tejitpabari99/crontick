/**
 * Per-run context supplied by non-time trigger sources (SP05 `after`, SP06
 * webhook, SP10 time dispatch). Reusable: `env` is merged last so trigger vars
 * (`CRONTICK_*`) can never be shadowed by `action.env`; `promptSuffix` is
 * appended to the prompt text.
 */
export interface RunContext {
  env?: Record<string, string>;
  promptSuffix?: string;
}

/**
 * The single env merge for a run. Priority (low -> high):
 * process.env < engine/prompt env < env file < action.env < context env.
 */
export function buildRunEnv(
  promptEnv: Record<string, string> | undefined,
  envFileVars: Record<string, string> | undefined,
  actionEnv: Record<string, string> | undefined,
  ctxEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(promptEnv ?? {}),
    ...(envFileVars ?? {}),
    ...(actionEnv ?? {}),
    ...(ctxEnv ?? {}),
  } as NodeJS.ProcessEnv;
}
