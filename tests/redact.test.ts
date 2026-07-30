import { describe, expect, it } from 'vitest';
import { redactText, redactValue, isSensitiveKeyHint } from '../src/logger.js';
import { redactForLlm } from '../src/mcp/index.js';

const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const HEX_LOOKALIKE = '0123456789abcdef0123456789abcdef01234567';
const BASE62_LOOKALIKE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';

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

describe('logger secret classifier', () => {
  it('matches only precise sensitive key-hint suffixes', () => {
    for (const keyHint of ['OPENAI_API_KEY', 'clientSecret', 'AWS_SECRET_ACCESS_KEY', 'authorization', 'refreshToken']) {
      expect(isSensitiveKeyHint(keyHint), keyHint).toBe(true);
    }

    for (const keyHint of ['NON_SECRET', 'NOT_TOKEN', 'NO_PASSWORD', 'secretary', 'monkey', 'PUBLIC_KEY']) {
      expect(isSensitiveKeyHint(keyHint), keyHint).toBe(false);
    }

    const structured = redactValue({
      OPENAI_API_KEY: 'openai-secret',
      clientSecret: 'client-secret',
      NON_SECRET: 'safe-visible',
      NOT_TOKEN: 'safe-visible',
      NO_PASSWORD: 'safe-visible',
      secretary: 'safe-visible',
      monkey: 'safe-visible',
      PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI',
    }) as Record<string, string>;

    expect(structured.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(structured.clientSecret).toBe('[REDACTED]');
    expect(structured.NON_SECRET).toBe('safe-visible');
    expect(structured.NOT_TOKEN).toBe('safe-visible');
    expect(structured.NO_PASSWORD).toBe('safe-visible');
    expect(structured.secretary).toBe('safe-visible');
    expect(structured.monkey).toBe('safe-visible');
    expect(structured.PUBLIC_KEY).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI');
  });

  it('preserves negated and substring-trap assignments in text', () => {
    const text = 'NON_SECRET=alpha NOT_TOKEN=beta NO_PASSWORD=gamma secretary=delta monkey=epsilon PUBLIC_KEY=zeta';
    expect(redactText(text)).toBe(text);
  });

  it('redacts contextual aws secret access keys for env-style and quoted keys', () => {
    expect(redactText(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`)).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(redactText(`{"secretAccessKey":"${AWS_SECRET_ACCESS_KEY}"}`)).toBe('{"secretAccessKey":"[REDACTED]"}');
  });

  it('uses a strict standalone aws fallback heuristic', () => {
    expect(AWS_SECRET_ACCESS_KEY).toHaveLength(40);
    expect(HEX_LOOKALIKE).toHaveLength(40);
    expect(BASE62_LOOKALIKE).toHaveLength(40);

    const result = redactText(`standalone ${AWS_SECRET_ACCESS_KEY} ${HEX_LOOKALIKE} ${BASE62_LOOKALIKE}`);

    expect(result).toContain('standalone [REDACTED]');
    expect(result).toContain(HEX_LOOKALIKE);
    expect(result).toContain(BASE62_LOOKALIKE);
  });
});
