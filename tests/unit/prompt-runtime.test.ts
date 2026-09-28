import { describe, expect, it } from 'vitest';
import { promptRuntimeValidationMessage } from '../../src/prompt-runtime.js';

// Regression test for a bug where two prompt-runtime fallbacks still defaulted
// to the removed 'copilot' engine (SP01 removed the copilot engine entirely;
// claude is now the only engine). See src/prompt-runtime.ts's
// promptRuntimeArgv, which falls back to a hardcoded engine name when
// `engine` is omitted from the runtime-validation input (used by
// job-input.ts's args-only patch validation path, where the final resolved
// engine isn't known yet at validation time).
describe('promptRuntimeValidationMessage — omitted-engine fallback', () => {
  it('falls back to the claude engine name, not the removed copilot default', () => {
    // 'claude' is 6 characters; the removed 'copilot' default was 7. Pick a
    // prompt length so the Windows command-line estimate lands exactly on the
    // safe-limit boundary (30,000) when argv[0] is 'claude', but one
    // character over it (30,001) when argv[0] is 'copilot' -- so an omitted
    // engine only behaves like 'claude', never like the removed 'copilot'.
    const boundaryPrompt = 'x'.repeat(29_993);

    expect(promptRuntimeValidationMessage({ prompt: boundaryPrompt, engine: 'claude' })).toBeUndefined();
    expect(promptRuntimeValidationMessage({ prompt: boundaryPrompt, engine: 'copilot' })).toMatch(
      /Windows-safe command line limit/,
    );

    // Omitting engine entirely must match the 'claude' outcome above, not 'copilot'.
    expect(promptRuntimeValidationMessage({ prompt: boundaryPrompt })).toBeUndefined();
  });
});
