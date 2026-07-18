import { describe, it, expect } from 'vitest';
import { redactForLlm } from '../src/mcp/index.js';

describe('redactForLlm', () => {
  it('replaces loopback address', () => {
    expect(redactForLlm('connect to 127.0.0.1:3000')).not.toContain('3000');
    expect(redactForLlm('connect to 127.0.0.1:3000')).toContain('<daemon-addr>');
  });

  it('replaces Windows absolute paths', () => {
    const result = redactForLlm('file at C:\\Users\\me\\AppData\\crontick\\jobs');
    expect(result).toContain('<path>');
    expect(result).not.toContain('Users');
  });

  it('replaces POSIX absolute paths', () => {
    const result = redactForLlm('file at /usr/local/bin/crontick');
    expect(result).toContain('<path>');
    expect(result).not.toContain('/usr/local');
  });

  it('does NOT mangle http://example.com/v1/api', () => {
    const msg = 'fetch failed for http://example.com/v1/api';
    const result = redactForLlm(msg);
    expect(result).toContain('http://example.com/v1/api');
    expect(result).not.toContain('http:/<path>');
  });

  it('does NOT mangle https URLs', () => {
    const msg = 'error connecting to https://api.example.com/webhook/path';
    const result = redactForLlm(msg);
    expect(result).toContain('https://api.example.com/webhook/path');
  });

  it('replaces POSIX path at start of string', () => {
    const result = redactForLlm('/home/user/projects/crontick is the path');
    expect(result).toContain('<path>');
  });
});
