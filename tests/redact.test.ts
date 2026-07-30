import { describe, expect, it } from 'vitest';
import { createStreamingTextRedactor, isSensitiveKeyHint, redactText, redactValue } from '../src/logger.js';
import { redactForLlm } from '../src/mcp/index.js';

const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const HEX_LOOKALIKE = '0123456789abcdef0123456789abcdef01234567';
const BASE62_LOOKALIKE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';
const PRIVATE_KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  'line-one',
  'line-two',
  '-----END PRIVATE KEY-----',
].join('\n');
const CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'cert-body',
  '-----END CERTIFICATE-----',
].join('\n');
const PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'public-body',
  '-----END PUBLIC KEY-----',
].join('\n');

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

describe('logger private-key redaction', () => {
  it('redacts full PEM private-key blocks in stateless text', () => {
    expect(redactText(`before\n${PRIVATE_KEY_BLOCK}\nafter`)).toBe('before\n[REDACTED]\nafter');
  });

  it('redacts lone PEM private-key markers without touching other PEM types', () => {
    expect(redactText('value=-----BEGIN PRIVATE KEY-----')).toBe('value=[REDACTED]');
    expect(redactText('value=-----END RSA PRIVATE KEY-----')).toBe('value=[REDACTED]');
    expect(redactText('value=-----BEGIN CERTIFICATE-----')).toBe('value=-----BEGIN CERTIFICATE-----');
    expect(redactText('value=-----BEGIN PUBLIC KEY-----')).toBe('value=-----BEGIN PUBLIC KEY-----');
  });

  it('redacts PEM content split across two write chunks', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write('prefix -----BEGIN PRIVATE KEY-----\nline-one\n')
      + redactor.write('line-two\n-----END PRIVATE KEY----- suffix')
      + redactor.flush();

    expect(output).toBe('prefix [REDACTED] suffix');
    expect(output).not.toContain('line-one');
    expect(output).not.toContain('line-two');
    expect(output).not.toContain('PRIVATE KEY');
  });

  it('redacts PEM markers split mid-line across chunk boundaries', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write('prefix -----BEG')
      + redactor.write('IN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY----- suffix')
      + redactor.flush();

    expect(output).toBe('prefix [REDACTED] suffix');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('PRIVATE KEY');
  });

  it('does not leak buffered private-key fragments on flush at EOF', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write('prefix -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIV') + redactor.flush();

    expect(output).toBe('prefix [REDACTED]');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('BEGIN PRIVATE KEY');
    expect(output).not.toContain('END PRIV');
  });

  it('leaves certificate and public-key PEM text visible', () => {
    expect(redactText(CERTIFICATE_PEM)).toBe(CERTIFICATE_PEM);
    expect(redactText(PUBLIC_KEY_PEM)).toBe(PUBLIC_KEY_PEM);

    const redactor = createStreamingTextRedactor();
    const output = redactor.write(`cert=${CERTIFICATE_PEM}\npub=${PUBLIC_KEY_PEM}`) + redactor.flush();

    expect(output).toBe(`cert=${CERTIFICATE_PEM}\npub=${PUBLIC_KEY_PEM}`);
    expect(output).not.toContain('[REDACTED]');
  });
});
