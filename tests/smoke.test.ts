import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('package exports', () => {
  it('VERSION is a non-empty string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
