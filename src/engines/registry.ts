import type { EngineConfig } from '../schemas/config.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { RawAdapter } from './raw-adapter.js';
import type { EngineAdapter } from './types.js';

/** Engine types select their implementation through this one registry. */
export const ENGINE_ADAPTERS: Readonly<Record<EngineConfig['type'], EngineAdapter>> = Object.freeze({
  raw: new RawAdapter(),
  claude: new ClaudeAdapter(),
});

export function getEngineAdapter(type: EngineConfig['type']): EngineAdapter {
  return ENGINE_ADAPTERS[type];
}
