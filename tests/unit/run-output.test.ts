import { describe, expect, it } from 'vitest';
import { buildRunOutput, cleanOutputText, normalizeUsage, type RunOutputSource } from '../../src/run-output.js';
import { EngineOutputCollector } from '../../src/daemon/output-collector.js';

/** Feed captured engine chunks through the streaming collector and build the run's output view. */
function build(run: RunOutputSource, chunks: Array<{ stream: string; data: string }>) {
  const collector = new EngineOutputCollector(1_000_000);
  for (const c of chunks) {
    if (c.stream === 'stdout') collector.pushStdout(Buffer.from(c.data));
    else if (c.stream === 'stderr') collector.pushStderr(Buffer.from(c.data));
  }
  collector.end();
  return buildRunOutput(run, collector.toEngineOutput());
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const b64 = Buffer.from('const fs = require("node:fs"); fs.writeFileSync("x", "y");'.repeat(8)).toString('base64');

const hookEvent = {
  type: 'system', subtype: 'hook_started', hook_name: 'SessionEnd',
  command: `"node" -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`,
};
const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'let me think', signature: 'SIG'.repeat(200) }] } };
const answer = { type: 'assistant', message: { content: [{ type: 'text', text: 'interim text' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'file-a\nfile-b' }] } };

const baseRun = { id: 'r1', status: 'success', sessionId: 's1', costUsd: 0.01, turns: 2, durationMs: 1500 };

describe('EngineOutputCollector stream trimming', () => {
  it('keeps only the final result event and discards every other event immediately', () => {
    const c = new EngineOutputCollector(1000);
    const lines: string[] = [];
    const tracked = new EngineOutputCollector(1000, (l) => lines.push(l));
    for (const ev of [hookEvent, thinking, answer, toolResult]) {
      tracked.pushStdout(Buffer.from(line(ev)));
      c.pushStdout(Buffer.from(line(ev)));
    }
    expect(lines).toHaveLength(4); // onLine still sees each line (terminal-error detection) ...
    expect(c.parseSource().stdout).toBe(''); // ... but nothing is retained
    expect(c.toEngineOutput()).toMatchObject({ format: 'claude-stream-json', result: null });
    c.pushStdout(Buffer.from(line({ type: 'result', subtype: 'success', is_error: false, result: 'final', usage: { input_tokens: 1 } })));
    const source = c.parseSource();
    expect(JSON.parse(source.stdout)).toMatchObject({ type: 'result', usage: { input_tokens: 1 } });
    expect(source.stdout).not.toContain('interim text');
  });

  it('does not grow with stream length: a million discarded events leave only the result', () => {
    const c = new EngineOutputCollector(1000);
    const event = Buffer.from(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }));
    for (let i = 0; i < 2000; i++) c.pushStdout(event);
    c.pushStdout(Buffer.from(line({ type: 'result', is_error: false, result: 'done' })));
    c.end();
    expect(c.parseSource().stdout.length).toBeLessThan(200);
    expect(c.toEngineOutput()?.result).toBe('done');
  });

  it('has no line-size limit: a multi-megabyte result line split across chunks is kept whole', () => {
    const big = 'word '.repeat(1024 * 1024);
    const full = line({ type: 'result', is_error: false, result: big });
    const c = new EngineOutputCollector(1000);
    for (let i = 0; i < full.length; i += 65536) c.pushStdout(Buffer.from(full.slice(i, i + 65536)));
    c.end();
    expect(c.toEngineOutput()?.result?.length).toBe(big.length);
  });

  it('keeps a final result line with no trailing newline and multibyte characters split across chunks', () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'h\u00e9llo \u{1F600}' }));
    const c = new EngineOutputCollector(1000);
    c.pushStdout(bytes.subarray(0, 40));
    c.pushStdout(bytes.subarray(40));
    c.end();
    expect(c.toEngineOutput()?.result).toBe('h\u00e9llo \u{1F600}');
  });

  it('keeps stderr in full (no size cap) and redacts secrets', () => {
    const c = new EngineOutputCollector(10);
    c.pushStderr(Buffer.from('err '.repeat(20_000) + ' sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'));
    c.end();
    const out = c.toEngineOutput();
    expect(out?.stderr.length).toBeGreaterThan(50_000);
    expect(out?.stderr).not.toContain('abcdefghijklmnop');
  });

  it('caps plain stdout with a marker and reports truncation', () => {
    const c = new EngineOutputCollector(20);
    c.pushStdout(Buffer.from('0123456789\n0123456789\nnever stored\n'));
    expect(c.truncated).toBe(true);
    const text = c.toEngineOutput()?.result ?? '';
    expect(text).toContain('output truncated');
    expect(text).not.toContain('never stored');
  });

  it('stores no assistant text segments on the output view', () => {
    const out = build(baseRun, [{ stream: 'stdout', data: line(answer) + line({ type: 'result', is_error: false, result: 'R' }) }]);
    expect(out).not.toHaveProperty('output');
    expect(JSON.stringify(out)).not.toContain('interim text');
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
    expect(out.result).toBeNull(); // an error result is not an answer
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
    expect(out.stderr).toBe('warning: something');
  });

  it('returns nulls for a run with no output and propagates outputTruncated', () => {
    const out = build({ ...baseRun, outputTruncated: true, sessionId: undefined }, []);
    expect(out).toMatchObject({ result: null, error: null, sessionId: null, truncated: true });
  });

  it('builds a null-output view when the run never produced engine output', () => {
    const out = buildRunOutput({ ...baseRun, status: 'skipped', error: 'overlap=skip' });
    expect(out).toMatchObject({ format: 'text', result: null, stderr: '', error: 'overlap=skip' });
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
