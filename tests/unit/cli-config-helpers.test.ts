import { describe, expect, it } from 'vitest';
import { CrontickError } from '../../src/errors.js';
import { flattenConfigLines, formatConfigValue, writeConfigWithInFlight, type InFlightIo } from '../../src/cli/config-write.js';

function io(interactive: boolean, answer = ''): InFlightIo & { questions: string[] } {
  const questions: string[] = [];
  return { interactive, questions, async ask(q) { questions.push(q); return answer; } };
}

const inFlightError = () => new CrontickError('RUNS_IN_FLIGHT', 'Runs are in flight: r1 (job a). Choose inFlight "stop" or "wait".', { runs: [{ runId: 'r1' }, { runId: 'r2' }] });

function fake(failFirst: boolean) {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    async run(inFlight?: 'stop' | 'wait') {
      calls.push(inFlight);
      if (failFirst && inFlight === undefined) throw inFlightError();
      return { ok: true };
    },
  };
}

describe('writeConfigWithInFlight', () => {
  it('passes flag choice straight through, no prompt', async () => {
    const f = fake(false); const i = io(true);
    await writeConfigWithInFlight(f.run, { stopRunning: true }, i);
    expect(f.calls).toEqual(['stop']);
    expect(i.questions).toEqual([]);
  });

  it('rejects both flags', async () => {
    await expect(writeConfigWithInFlight(fake(false).run, { stopRunning: true, waitRunning: true }, io(true))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('non-TTY without flag rethrows RUNS_IN_FLIGHT mentioning flags', async () => {
    const f = fake(true);
    await expect(writeConfigWithInFlight(f.run, {}, io(false))).rejects.toMatchObject({ code: 'RUNS_IN_FLIGHT', message: expect.stringContaining('--stop-running') });
    expect(f.calls).toEqual([undefined]);
  });

  it.each([['s', 'stop'], ['stop', 'stop'], ['w', 'wait'], ['WAIT', 'wait']])('TTY answer %s retries with %s', async (answer, choice) => {
    const f = fake(true); const i = io(true, answer);
    await writeConfigWithInFlight(f.run, {}, i);
    expect(f.calls).toEqual([undefined, choice]);
    expect(i.questions[0]).toContain('2 run(s) in flight');
  });

  it.each(['', 'c', 'x'])('TTY answer "%s" cancels', async (answer) => {
    const f = fake(true);
    await expect(writeConfigWithInFlight(f.run, {}, io(true, answer))).rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });
    expect(f.calls).toEqual([undefined]);
  });

  it('other errors pass through', async () => {
    await expect(writeConfigWithInFlight(async () => { throw new CrontickError('CONFIG_KEY_READ_ONLY', 'x'); }, {}, io(true))).rejects.toMatchObject({ code: 'CONFIG_KEY_READ_ONLY' });
  });
});

describe('config list formatting', () => {
  it('flattens leaves, tags keys absent from the file with (default)', () => {
    const config = { defaults: { timeoutSec: 5, overlap: 'skip' }, engines: { x: { command: 'c', args: ['-p'] } }, defaultEngine: 'x' };
    const stored = { defaults: { timeoutSec: 5 }, engines: { x: { command: 'c' } } };
    expect(flattenConfigLines(config, stored)).toEqual([
      'defaults.timeoutSec = 5',
      'defaults.overlap = "skip" (default)',
      'engines.x.command = "c"',
      'engines.x.args = ["-p"] (default)',
      'defaultEngine = "x" (default)',
    ]);
  });

  it('treats a whole stored object value as present, empty objects as leaves', () => {
    expect(flattenConfigLines({ a: { env: {} }, b: 1 }, { a: { env: {} } })).toEqual(['a.env = {}', 'b = 1 (default)']);
  });

  it('formatConfigValue prints strings raw and others as JSON', () => {
    expect(formatConfigValue('abc')).toBe('abc');
    expect(formatConfigValue(5)).toBe('5');
    expect(formatConfigValue({ a: 1 })).toBe('{"a":1}');
  });
});
