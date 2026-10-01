/** A configurable Claude CLI stand-in that runs through the real Node binary. */
export interface FakeClaudeOptions {
  exitCode?: number;
  isError?: boolean;
  delayMs?: number;
  result?: string;
  omitResult?: boolean;
  usage?: unknown;
  /** Number of noisy ~1 KB assistant events to emit before the result. */
  flood?: number;
  /** When set, run the --settings SessionEnd hook with this transcript_path on stdin, like real Claude. */
  hookTranscriptPath?: string;
  /** Bytes of stderr to write. */
  stderrBytes?: number;
}

const fakeClaudeProgram = String.raw`
const config = JSON.parse(process.env.CRONTICK_FAKE_CLAUDE_OPTIONS || '{}');
const argv = process.argv.slice(1);
const flagValue = (name) => argv[argv.indexOf(name) + 1];
const sessionId = argv.includes('--session-id') ? flagValue('--session-id') : flagValue('--resume');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
setTimeout(() => {
  if (config.stderrBytes) process.stderr.write('err '.repeat(Math.ceil(config.stderrBytes / 4)) + '\n');
  for (let i = 0; i < (config.flood || 0); i++) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'noise ' + i + ' ' + 'z'.repeat(1000) }] } });
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'fake reply' }] } });
  if (!config.omitResult) {
    emit({ type: 'result', subtype: config.isError ? 'error_during_execution' : 'success', is_error: !!config.isError,
      session_id: sessionId, total_cost_usd: 0.01, num_turns: 1,
      usage: config.usage ?? { input_tokens: 10, output_tokens: 5 }, result: config.result || 'fake reply' });
  }
  if (config.hookTranscriptPath) {
    const hook = JSON.parse(flagValue('--settings'))['ho' + 'oks']['Session' + 'End'][0]['ho' + 'oks'][0].command;
    try { require('node:child_process').execSync(hook, { input: JSON.stringify({ session_id: sessionId, transcript_path: config.hookTranscriptPath, hook_event_name: 'Session' + 'End' }), stdio: ['pipe','pipe','pipe'] }); } catch (e) { process.stderr.write('HOOKFAIL ' + e.message + String(e.stderr)); }
  }
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
