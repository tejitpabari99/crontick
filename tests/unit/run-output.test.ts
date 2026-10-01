import { describe, expect, it } from 'vitest';
import { buildRunOutput, cleanOutputText, normalizeUsage, parseEngineOutput, type RunOutputSource } from '../../src/run-output.js';

/** Parse captured engine chunks (only stdout/stderr are engine output) and build the run's output view. */
function build(run: RunOutputSource, chunks: Array<{ stream: string; data: string }>) {
  const join = (stream: string): string => chunks.filter((c) => c.stream === stream).map((c) => c.data).join('');
  return buildRunOutput(run, parseEngineOutput(join('stdout'), join('stderr')));
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const b64 = Buffer.from('const fs = require("node:fs"); fs.writeFileSync("x", "y");'.repeat(8)).toString('base64');

const hookEvent = {
  type: 'system', subtype: 'hook_started', hook_name: 'SessionEnd',
  command: `"node" -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`,
};
const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'let me think', signature: 'SIG'.repeat(200) }] } };
const answer = { type: 'assistant', message: { content: [{ type: 'text', text: 'The answer is 42.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'file-a\nfile-b' }] } };

const baseRun = { id: 'r1', status: 'success', sessionId: 's1', costUsd: 0.01, turns: 2, durationMs: 1500 };

const asst = (...blocks: unknown[]) => line({ type: 'assistant', message: { content: blocks } });
const text = (t: string) => ({ type: 'text', text: t });
const tool = (name: string) => ({ type: 'tool_use', name, input: {} });

describe('run output assistant-text-only output', () => {
  it('joins text segments split by tool calls with ---, and never emits [tool] lines', () => {
    const stdout = asst(text('A')) + asst(tool('Bash')) + asst(tool('Read')) + line(toolResult) + asst(text('B'));
    const out = build(baseRun, [{ stream: 'stdout', data: stdout }]);
    expect(out.output).toBe('A\n\n---\n\nB');
    expect(out.output).not.toContain('[tool]');
  });

  it('keeps consecutive texts (no tool between) in one segment without a separator', () => {
    const stdout = asst(text('A')) + asst(text('B')) + asst(text('C'), tool('Bash'), text('D'));
    expect(build(baseRun, [{ stream: 'stdout', data: stdout }]).output).toBe('A\n\nB\n\nC\n\n---\n\nD');
  });

  it('never emits leading or trailing separators and returns empty when there is no text', () => {
    const toolsOnly = asst(tool('Bash')) + line(toolResult) + asst(tool('Read'));
    expect(build(baseRun, [{ stream: 'stdout', data: toolsOnly }]).output).toBe('');
    const edge = asst(tool('Bash')) + asst(text('only')) + asst(tool('Read'));
    expect(build(baseRun, [{ stream: 'stdout', data: edge }]).output).toBe('only');
  });

  it('excludes thinking blocks, hook events, and tool results', () => {
    const stdout = line(hookEvent) + line(thinking) + line(toolResult) + asst(text('visible'));
    const out = build(baseRun, [{ stream: 'stdout', data: stdout }]);
    expect(out.output).toBe('visible');
  });

  it('redacts secrets per segment', () => {
    const stdout = asst(text('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD')) + asst(tool('Bash')) + asst(text('ok'));
    const out = build(baseRun, [{ stream: 'stdout', data: stdout }]);
    expect(out.output).not.toContain('abcdefghijklmnop');
    expect(out.output).toContain('---');
  });
});

describe('buildRunOutput', () => {
  it('extracts the final result and a readable transcript from Claude stream-json, dropping noise', () => {
    const stdout = line(hookEvent) + line(thinking) + line(answer) + line(toolResult)
      + line({ type: 'result', subtype: 'success', is_error: false, result: 'The answer is 42.' });
    const out = build(baseRun, [{ stream: 'stdout', data: stdout }]);
    expect(out.format).toBe('claude-stream-json');
    expect(out.result).toBe('The answer is 42.');
    expect(out.error).toBeNull();
    expect(out.output).toBe('The answer is 42.');
    expect(out.output).not.toContain('[tool]');
    expect(JSON.stringify(out)).not.toContain('SIGSIG');
    expect(JSON.stringify(out)).not.toContain(b64);
    expect(out).toMatchObject({ sessionId: 's1', costUsd: 0.01, turns: 2, durationMs: 1500, truncated: false });
  });

  it('reassembles events split across captured chunks', () => {
    const full = line({ type: 'result', subtype: 'success', is_error: false, result: 'split ok' });
    const out = build(baseRun, [{ stream: 'stdout', data: full.slice(0, 20) }, { stream: 'stdout', data: full.slice(20) }]);
    expect(out.result).toBe('split ok');
  });

  it('reports the error from an is_error result and an authentication assistant message', () => {
    const message = 'Failed to authenticate. API Error: 401 OAuth access token is invalid';
    const stdout = line({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: message }] } })
      + line({ type: 'result', subtype: 'success', is_error: true, result: message });
    const out = build({ ...baseRun, status: 'failed' }, [{ stream: 'stdout', data: stdout }]);
    expect(out.error).toBe(message);
    expect(out.result).toBe(message); // falls back to the last assistant text
    const withRunError = build({ ...baseRun, status: 'failed', error: 'recorded error' }, [{ stream: 'stdout', data: stdout }]);
    expect(withRunError.error).toBe('recorded error');
  });

  it('treats non-JSON engine output as plain text and keeps stderr separate', () => {
    const out = build(baseRun, [
      { stream: 'stdout', data: 'hello\nworld\n' },
      { stream: 'stderr', data: 'warning: something\n' },
      { stream: 'crontick', data: '[crontick] run started\n' },
    ]);
    expect(out.format).toBe('text');
    expect(out.result).toBe('hello\nworld');
    expect(out.output).toBe('hello\nworld');
    expect(out.stderr).toBe('warning: something');
    expect(out.output).not.toContain('crontick');
  });

  it('returns nulls for a run with no output and propagates outputTruncated', () => {
    const out = build({ ...baseRun, outputTruncated: true, sessionId: undefined }, []);
    expect(out).toMatchObject({ result: null, error: null, output: '', sessionId: null, truncated: true });
  });

  it('builds a null-output view when the run never produced engine output', () => {
    const out = buildRunOutput({ ...baseRun, status: 'skipped', error: 'overlap=skip' });
    expect(out).toMatchObject({ format: 'text', result: null, output: '', stderr: '', error: 'overlap=skip' });
  });

  it('cleanOutputText strips hook eval payloads and long base64 blobs', () => {
    expect(cleanOutputText(`node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`)).toContain('<hook payload omitted>');
    expect(cleanOutputText(`blob ${b64}`)).toContain('<base64 omitted>');
  });
});

const sampleUsage = {
  input_tokens: 34, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 500,
  output_tokens_details: { thinking_tokens: 120 }, service_tier: 'standard',
  iterations: [{ input_tokens: 8, output_tokens: 10 }],
};

describe('normalizeUsage', () => {
  it('maps the sample usage object to totals and ignores iterations', () => {
    expect(normalizeUsage(sampleUsage)).toEqual({
      inputTokens: 34, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 100, thinkingTokens: 120,
    });
  });

  it('leaves thinking tokens undefined when missing', () => {
    const n = normalizeUsage({ ...sampleUsage, output_tokens_details: undefined });
    expect(n.thinkingTokens).toBeUndefined();
    expect(n.inputTokens).toBe(34);
  });

  it('returns no fields for non-object input and ignores non-numeric fields', () => {
    for (const bad of [null, undefined, 'x', 5, [1, 2]]) expect(normalizeUsage(bad)).toEqual({});
    expect(normalizeUsage({ input_tokens: '3', output_tokens: -1 })).toEqual({});
  });

  it('is exposed on the run output view without changing the stored usageJson', () => {
    const usageJson = JSON.stringify(sampleUsage);
    const out = build({ ...baseRun, usageJson }, []);
    expect(out.usage).toMatchObject({ inputTokens: 34, outputTokens: 500 });
    expect(usageJson).toBe(JSON.stringify(sampleUsage));
    expect(build(baseRun, []).usage).toBeNull();
  });
});
