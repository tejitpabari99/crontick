import { EngineAdapter, type EngineInvocation, type EngineResult } from './types.js';

/** Placeholder for Claude Code invocation and result handling. */
export class ClaudeAdapter extends EngineAdapter {
  reservedArgs(): ReadonlySet<string> {
    throw new Error('ClaudeAdapter is not implemented yet');
  }

  buildInvocation(): EngineInvocation {
    throw new Error('ClaudeAdapter is not implemented yet');
  }

  parseResult(): EngineResult {
    throw new Error('ClaudeAdapter is not implemented yet');
  }

  resolveSessionId(): string | undefined {
    throw new Error('ClaudeAdapter is not implemented yet');
  }
}
