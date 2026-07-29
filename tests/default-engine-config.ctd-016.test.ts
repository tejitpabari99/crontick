import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { BUILT_IN_CONFIG, buildPromptRunCommand } from '../src/config.js';

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

describe('CTD-016 built-in copilot engine defaults', () => {
  it("appends the prompt after Copilot's non-interactive flags", () => {
    expect(BUILT_IN_CONFIG.engines.copilot.args).toEqual(['--allow-all-tools', '-p']);

    expect(buildPromptRunCommand({
      kind: 'prompt',
      prompt: 'Say hello in exactly one word.',
      args: ['--model', 'gpt-5.4'],
      reuseSession: false,
    }, { env: makeHome() })).toEqual({
      command: 'copilot',
      args: ['--allow-all-tools', '-p', 'Say hello in exactly one word.', '--model', 'gpt-5.4'],
      env: {},
      engine: 'copilot',
    });
  });
});
