import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { BUILT_IN_CONFIG, buildPromptRunCommand, writeConfigFile } from '../../src/config.js';

const scratchRoot = resolve('.crontick', 'default-engine-config-ctd-016');
const cleanupDirs: string[] = [];

function makeHome(): NodeJS.ProcessEnv {
  const home = join(scratchRoot, randomUUID());
  mkdirSync(home, { recursive: true });
  cleanupDirs.push(home);
  return { ...process.env, CRONTICK_HOME: home };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('built-in engine defaults', () => {
  it('uses the Claude adapter for the built-in engine', () => {
    expect(BUILT_IN_CONFIG.engines.claude).toEqual({ command: 'claude', args: [], env: {}, type: 'claude' });

    const invocation = buildPromptRunCommand({
      kind: 'prompt',
      prompt: 'Say hello in exactly one word.',
      args: ['--model', 'gpt-5.4'],
      reuseSession: false,
    }, { env: makeHome() });
    expect(invocation).toMatchObject({
      command: 'claude',
      env: {},
      engine: 'claude',
    });
    expect(invocation.args.slice(0, 7)).toEqual([
      '-p', 'Say hello in exactly one word.', '--output-format', 'stream-json', '--verbose', '--session-id', invocation.sessionId,
    ]);
    expect(invocation.args.slice(7, -1)).toEqual(['--model', 'gpt-5.4', '--settings']);
    expect(JSON.parse(invocation.args.at(-1)!)).toHaveProperty('hooks.SessionEnd');
  });

  it("keeps the prompt immediately after a custom engine's final prompt-taking flag", () => {
    const env = makeHome();
    writeConfigFile({
      defaultEngine: 'custom',
      engines: {
        custom: {
          command: 'custom-engine',
          args: ['--model', 'mini', '--prompt'],
          env: { CUSTOM_ENGINE_MODE: 'test' },
        },
      },
    }, { env });

    expect(buildPromptRunCommand({
      kind: 'prompt',
      engine: 'custom',
      prompt: 'Summarize the status in one sentence.',
      args: ['--temperature', '0'],
      reuseSession: false,
    }, { env })).toEqual({
      command: 'custom-engine',
      args: ['--model', 'mini', '--prompt', 'Summarize the status in one sentence.', '--temperature', '0'],
      env: { CUSTOM_ENGINE_MODE: 'test' },
      engine: 'custom',
    });
  });
});
