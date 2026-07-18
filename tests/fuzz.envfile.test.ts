import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseEnvFile } from '../src/daemon/runner.js';

describe('fuzz: parseEnvFile', () => {
  it('never throws on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (input) => {
        let result: Record<string, string> | undefined;
        expect(() => {
          result = parseEnvFile(input);
        }).not.toThrow();
        expect(typeof result).toBe('object');
        for (const [key, value] of Object.entries(result!)) {
          expect(typeof key).toBe('string');
          expect(typeof value).toBe('string');
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on multi-line arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 200 }), { maxLength: 50 }).map((lines) => lines.join('\n')),
        (input) => {
          expect(() => parseEnvFile(input)).not.toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });
});
