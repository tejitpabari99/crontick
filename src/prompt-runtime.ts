/**
 * Prompt action runtime validation. Enforces two constraints before a prompt
 * job can be persisted:
 * 1. User-supplied args must not include crontick-managed flags (--prompt, --session-id, etc.)
 * 2. Estimated Windows command-line length must stay under the safe limit (30K of 32K max)
 */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const SAFE_PROMPT_COMMAND_LINE_LIMIT = 30_000;

/** Args that crontick manages internally; users cannot pass these as raw engine args. */
const RESERVED_PROMPT_ARGS = new Set([
  '-p',
  '--prompt',
  '--session-id',
  '-r',
  '--resume',
  '--continue',
  '--connect',
]);

interface PromptRuntimeValidationInput {
  prompt: string;
  engine?: string;
  args?: string[];
  sessionId?: string;
}

export function promptRuntimeValidationMessage(action: PromptRuntimeValidationInput): string | undefined {
  const args = action.args ?? [];
  const reserved = args.find(isReservedPromptArg);
  if (reserved) {
    return `Raw prompt engine args cannot include crontick-managed prompt/session flag: ${reserved}`;
  }

  const argv = promptRuntimeArgv(action);
  const estimatedLength = estimateWindowsCommandLineLength(argv);
  if (estimatedLength > SAFE_PROMPT_COMMAND_LINE_LIMIT) {
    return `Prompt plus engine arguments exceed the Windows-safe command line limit (${estimatedLength}/${WINDOWS_COMMAND_LINE_LIMIT} characters). Shorten the prompt or arguments.`;
  }
  return undefined;
}

function promptRuntimeArgv(action: PromptRuntimeValidationInput): string[] {
  const args = action.args ?? [];
  const argv = [action.engine ?? 'copilot', action.prompt, ...args];
  if (action.sessionId) argv.push(`--session-id=${action.sessionId}`);
  return argv;
}

function isReservedPromptArg(arg: string): boolean {
  return RESERVED_PROMPT_ARGS.has(arg)
    || arg.startsWith('--prompt=')
    || arg.startsWith('--session-id=')
    || arg.startsWith('--resume=')
    || arg.startsWith('--connect=');
}

function estimateWindowsCommandLineLength(argv: string[]): number {
  return argv.reduce((total, arg, index) => total + (index === 0 ? 0 : 1) + quoteForWindowsEstimate(arg).length, 0);
}

function quoteForWindowsEstimate(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"` : arg;
}
