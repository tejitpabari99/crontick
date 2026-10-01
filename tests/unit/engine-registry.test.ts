import { describe, expect, it } from 'vitest';
import { EngineConfigSchema, PersistedEngineConfigSchema } from '../../src/schemas/config.js';
import { EngineAdapter } from '../../src/engines/types.js';
import { ClaudeAdapter } from '../../src/engines/claude-adapter.js';
import { RawAdapter } from '../../src/engines/raw-adapter.js';
import { getEngineAdapter } from '../../src/engines/registry.js';

describe('engine adapter selection', () => {
  it('defaults an engine config without type to raw', () => {
    expect(EngineConfigSchema.parse({ command: 'custom' })).toEqual({
      command: 'custom',
      args: [],
      env: {},
      type: 'raw',
    });
  });

  it('accepts either registered type and rejects unsupported types', () => {
    expect(EngineConfigSchema.parse({ command: 'claude', type: 'claude' }).type).toBe('claude');
    expect(EngineConfigSchema.safeParse({ command: 'other', type: 'other' }).success).toBe(false);
    expect(PersistedEngineConfigSchema.parse({ command: 'custom', type: 'raw' })).toEqual({
      command: 'custom',
      type: 'raw',
    });
  });

  it('resolves both types to constructible adapters', () => {
    expect(getEngineAdapter('raw')).toBeInstanceOf(EngineAdapter);
    expect(getEngineAdapter('raw')).toBeInstanceOf(RawAdapter);
    expect(getEngineAdapter('claude')).toBeInstanceOf(EngineAdapter);
    expect(getEngineAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
    expect(new RawAdapter()).toBeInstanceOf(EngineAdapter);
    expect(new ClaudeAdapter()).toBeInstanceOf(EngineAdapter);
  });
});
