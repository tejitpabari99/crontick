/** A configurable Claude CLI stand-in that runs through the real Node binary. */
export interface FakeClaudeOptions {
  exitCode?: number;
  isError?: boolean;
  delayMs?: number;
  result?: string;
}

const fakeClaudeProgram = String.raw`
const config = JSON.parse(process.env.CRONTICK_FAKE_CLAUDE_OPTIONS || '{}');
const argv = process.argv.slice(1);
const flagValue = (name) => argv[argv.indexOf(name) + 1];
const sessionId = argv.includes('--session-id') ? flagValue('--session-id') : flagValue('--resume');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
setTimeout(() => {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'fake reply' }] } });
  emit({ type: 'result', subtype: config.isError ? 'error_during_execution' : 'success', is_error: !!config.isError,
    session_id: sessionId, total_cost_usd: 0.01, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 }, result: config.result || 'fake reply' });
  process.exitCode = config.exitCode ?? 0;
}, config.delayMs ?? 0);
`;

/** Register this as a `type: 'claude'` engine to exercise real spawn and NDJSON capture. */
export function fakeClaudeEngineConfig(options: FakeClaudeOptions = {}) {
  return {
    command: process.execPath,
    args: ['-e', fakeClaudeProgram, '--'],
    env: { CRONTICK_FAKE_CLAUDE_OPTIONS: JSON.stringify(options) },
    type: 'claude' as const,
  };
}
