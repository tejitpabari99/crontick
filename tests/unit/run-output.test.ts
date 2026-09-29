import { describe, expect, it } from 'vitest';
import { buildRunOutput, cleanOutputText } from '../../src/run-output.js';

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

describe('buildRunOutput', () => {
  it('extracts the final result and a readable transcript from Claude stream-json, dropping noise', () => {
    const stdout = line(hookEvent) + line(thinking) + line(answer) + line(toolResult)
      + line({ type: 'result', subtype: 'success', is_error: false, result: 'The answer is 42.' });
    const out = buildRunOutput(baseRun, [{ stream: 'stdout', data: stdout }]);
    expect(out.format).toBe('claude-stream-json');
    expect(out.result).toBe('The answer is 42.');
    expect(out.error).toBeNull();
    expect(out.output).toBe('The answer is 42.\n[tool] Bash');
    expect(JSON.stringify(out)).not.toContain('SIGSIG');
    expect(JSON.stringify(out)).not.toContain(b64);
    expect(out).toMatchObject({ sessionId: 's1', costUsd: 0.01, turns: 2, durationMs: 1500, truncated: false });
  });

  it('reassembles events split across log chunks', () => {
    const full = line({ type: 'result', subtype: 'success', is_error: false, result: 'split ok' });
    const out = buildRunOutput(baseRun, [{ stream: 'stdout', data: full.slice(0, 20) }, { stream: 'stdout', data: full.slice(20) }]);
    expect(out.result).toBe('split ok');
  });

  it('reports the error from an is_error result and an authentication assistant message', () => {
    const message = 'Failed to authenticate. API Error: 401 OAuth access token is invalid';
    const stdout = line({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: message }] } })
      + line({ type: 'result', subtype: 'success', is_error: true, result: message });
    const out = buildRunOutput({ ...baseRun, status: 'failed' }, [{ stream: 'stdout', data: stdout }]);
    expect(out.error).toBe(message);
    expect(out.result).toBe(message); // falls back to the last assistant text
    const withRunError = buildRunOutput({ ...baseRun, status: 'failed', error: 'recorded error' }, [{ stream: 'stdout', data: stdout }]);
    expect(withRunError.error).toBe('recorded error');
  });

  it('treats non-JSON engine output as plain text and keeps stderr separate', () => {
    const out = buildRunOutput(baseRun, [
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
    const out = buildRunOutput({ ...baseRun, outputTruncated: true, sessionId: undefined }, []);
    expect(out).toMatchObject({ result: null, error: null, output: '', sessionId: null, truncated: true });
  });

  it('cleanOutputText strips hook eval payloads and long base64 blobs', () => {
    expect(cleanOutputText(`node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`)).toContain('<hook payload omitted>');
    expect(cleanOutputText(`blob ${b64}`)).toContain('<base64 omitted>');
  });
});
