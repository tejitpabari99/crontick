import { EngineAdapter, type EngineInvocation, type EngineResult } from './types.js';

/** Placeholder for the generic CLI behavior migrated in the next task. */
export class RawAdapter extends EngineAdapter {
  reservedArgs(): ReadonlySet<string> {
    throw new Error('RawAdapter is not implemented yet');
  }

  buildInvocation(): EngineInvocation {
    throw new Error('RawAdapter is not implemented yet');
  }

  parseResult(): EngineResult {
    throw new Error('RawAdapter is not implemented yet');
  }

  resolveSessionId(): string | undefined {
    throw new Error('RawAdapter is not implemented yet');
  }
}
