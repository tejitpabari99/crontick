export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
export const SAFE_PROMPT_COMMAND_LINE_LIMIT = 30_000;

export const RESERVED_PROMPT_ARGS = new Set([
  '-p',
  '--prompt',
  '--session-id',
  '-r',
  '--resume',
  '--continue',
  '--connect',
]);

export interface PromptRuntimeValidationInput {
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

export function promptRuntimeArgv(action: PromptRuntimeValidationInput): string[] {
  const args = action.args ?? [];
  const argv = [action.engine ?? 'copilot', action.prompt, ...args];
  if (action.sessionId) argv.push(`--session-id=${action.sessionId}`);
  return argv;
}

export function isReservedPromptArg(arg: string): boolean {
  return RESERVED_PROMPT_ARGS.has(arg)
    || arg.startsWith('--prompt=')
    || arg.startsWith('--session-id=')
    || arg.startsWith('--resume=')
    || arg.startsWith('--connect=');
}

export function estimateWindowsCommandLineLength(argv: string[]): number {
  return argv.reduce((total, arg, index) => total + (index === 0 ? 0 : 1) + quoteForWindowsEstimate(arg).length, 0);
}

function quoteForWindowsEstimate(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"` : arg;
}
