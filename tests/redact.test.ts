import { describe, expect, it } from 'vitest';
import { createStreamingTextRedactor, isSensitiveKeyHint, redactText, redactValue } from '../src/logger.js';
import { redactForLlm } from '../src/mcp/index.js';

const AWS_ACCESS_KEY_ID = 'AKIA1234567890ABCDEF';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const AWS_SESSION_ACCESS_KEY_ID = 'ASIA1234567890ABCDEF';
const HEX_LOOKALIKE = '0123456789abcdef0123456789abcdef01234567';
const BASE62_LOOKALIKE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';
const QA_BENIGN_BASE64 = 'aGVsbG8gd29ybGQgZnJvbSBjcm9udGljayBxYQ==';
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

describe('SAFE-003 logger secret classifier precision', () => {
  it('matches only precise sensitive key-hint suffixes', () => {
    for (const keyHint of ['OPENAI_API_KEY', 'clientSecret', 'AWS_SECRET_ACCESS_KEY', 'authorization', 'refreshToken', 'privateKey']) {
      expect(isSensitiveKeyHint(keyHint), keyHint).toBe(true);
    }

    for (const keyHint of ['NON_SECRET', 'NOT_TOKEN', 'NO_PASSWORD', 'secretary', 'monkey', 'PUBLIC_KEY']) {
      expect(isSensitiveKeyHint(keyHint), keyHint).toBe(false);
    }

    const structured = redactValue({
      OPENAI_API_KEY: 'openai-secret',
      clientSecret: 'client-secret',
      AWS_SECRET_ACCESS_KEY,
      authorization: 'Bearer super-secret',
      privateKey: PRIVATE_KEY_BLOCK,
      NON_SECRET: 'safe-visible',
      NOT_TOKEN: 'safe-visible',
      NO_PASSWORD: 'safe-visible',
      secretary: 'safe-visible',
      monkey: 'safe-visible',
      PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI',
    }) as Record<string, string>;

    expect(structured.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(structured.clientSecret).toBe('[REDACTED]');
    expect(structured.AWS_SECRET_ACCESS_KEY).toBe('[REDACTED]');
    expect(structured.authorization).toBe('[REDACTED]');
    expect(structured.privateKey).toBe('[REDACTED]');
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
});

describe('RED-003 logger must-redact corpus', () => {
  it('redacts contextual aws secret access keys for env-style, label-style, and quoted keys', () => {
    expect(redactText(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`)).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(redactText(`aws_secret_access_key=${AWS_SECRET_ACCESS_KEY}`)).toBe('aws_secret_access_key=[REDACTED]');
    expect(redactText(`AWS Secret Access Key: ${AWS_SECRET_ACCESS_KEY}`)).toBe('AWS Secret Access Key: [REDACTED]');
    expect(redactText(`{"secretAccessKey":"${AWS_SECRET_ACCESS_KEY}"}`)).toBe('{"secretAccessKey":"[REDACTED]"}');
  });

  it('redacts aws access key ids and nearby aws secret access keys', () => {
    expect(redactText(`${AWS_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY}`)).toBe('[REDACTED] [REDACTED]');
    expect(redactText(`${AWS_SESSION_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY}`)).toBe('[REDACTED] [REDACTED]');
  });

  it('does not over-redact unrelated same-line 40-character tokens far from aws access key ids', () => {
    expect(redactText(`id=${AWS_ACCESS_KEY_ID} context=benign payload=${QA_BENIGN_BASE64}`))
      .toBe(`id=[REDACTED] context=benign payload=${QA_BENIGN_BASE64}`);
    expect(redactText(`id=${AWS_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY} payload=${QA_BENIGN_BASE64}`))
      .toBe(`id=[REDACTED] [REDACTED] payload=${QA_BENIGN_BASE64}`);
  });

  it('preserves unlabeled standalone 40-character blobs without aws context', () => {
    expect(AWS_SECRET_ACCESS_KEY).toHaveLength(40);
    expect(HEX_LOOKALIKE).toHaveLength(40);
    expect(BASE62_LOOKALIKE).toHaveLength(40);
    expect(QA_BENIGN_BASE64).toHaveLength(40);

    const result = redactText(`payload: ${QA_BENIGN_BASE64} standalone ${AWS_SECRET_ACCESS_KEY} ${HEX_LOOKALIKE} ${BASE62_LOOKALIKE}`);

    expect(result).toBe(`payload: ${QA_BENIGN_BASE64} standalone ${AWS_SECRET_ACCESS_KEY} ${HEX_LOOKALIKE} ${BASE62_LOOKALIKE}`);
  });

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

  it('keeps isolated streaming state per redactor instance', () => {
    const first = createStreamingTextRedactor();
    const second = createStreamingTextRedactor();

    const firstOutput = first.write('alpha -----BEGIN PRIVATE KEY-----\nsecret\n') + first.flush();
    const secondOutput = second.write('beta ok') + second.flush();

    expect(firstOutput).toBe('alpha [REDACTED]');
    expect(firstOutput).not.toContain('secret');
    expect(secondOutput).toBe('beta ok');
  });

  it('redacts secret assignments split across chunk boundaries at multiple split points', () => {
    const cases = [
      {
        name: 'split mid key name',
        chunks: ['prefix AWS_SECRET_ACCESS_KE', `Y=${AWS_SECRET_ACCESS_KEY} suffix`],
      },
      {
        name: 'split mid value',
        chunks: ['prefix AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MD', 'ENG/bPxRfiCYEXAMPLEKEY suffix'],
      },
      {
        name: 'split across three writes',
        chunks: ['prefix AWS_SEC', 'RET_ACCESS_KEY=wJalrXUtnFEMI/K7', 'MDENG/bPxRfiCYEXAMPLEKEY suffix'],
      },
      {
        name: 'quoted split value',
        chunks: ['prefix {"secretAccessKey":"wJalrXUtnFEMI/', 'K7MDENG/bPxRfiCYEXAMPLEKEY"} suffix'],
        expected: 'prefix {"secretAccessKey":"[REDACTED]"} suffix',
      },
    ];

    for (const entry of cases) {
      const redactor = createStreamingTextRedactor();
      const output = entry.chunks.map((chunk) => redactor.write(chunk)).join('') + redactor.flush();
      expect(output, entry.name).toBe(entry.expected ?? 'prefix AWS_SECRET_ACCESS_KEY=[REDACTED] suffix');
      expect(output, entry.name).not.toContain(AWS_SECRET_ACCESS_KEY);
    }
  });

  it('does not leak a buffered secret-assignment tail on flush at EOF', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write('prefix AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MD') + redactor.flush();

    expect(output).toBe('prefix AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(output).not.toContain(AWS_SECRET_ACCESS_KEY);
    expect(output).not.toContain('wJalrXUtnFEMI/K7MD');
  });

  it('preserves benign trailing tokens after aws access key ids at stream flush', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write(`${AWS_ACCESS_KEY_ID} token`) + redactor.flush();

    expect(output).toBe('[REDACTED] token');
    expect(output).toContain('token');
  });

  it('still redacts nearby aws secrets split across streaming writes', () => {
    const redactor = createStreamingTextRedactor();
    const output = redactor.write(`${AWS_ACCESS_KEY_ID} `)
      + redactor.write(AWS_SECRET_ACCESS_KEY)
      + redactor.flush();

    expect(output).toBe('[REDACTED] [REDACTED]');
    expect(output).not.toContain(AWS_SECRET_ACCESS_KEY);
  });

  it('flushes long benign -----BEGIN lines instead of carrying them indefinitely', () => {
    const line = `-----BEGIN ${'A'.repeat(8_192)}
trailer`;
    const redactor = createStreamingTextRedactor();
    let streamed = '';
    for (let offset = 0; offset < line.length; offset += 64) {
      streamed += redactor.write(line.slice(offset, offset + 64));
    }
    const output = streamed + redactor.flush();

    expect(streamed.length).toBeGreaterThan(0);
    expect(output).toBe(line);
    expect(output).not.toContain('[REDACTED]');
  });
});

describe('SAFE-004 logger near-miss preservation', () => {
  it('leaves certificate and public-key PEM text visible', () => {
    expect(redactText(CERTIFICATE_PEM)).toBe(CERTIFICATE_PEM);
    expect(redactText(PUBLIC_KEY_PEM)).toBe(PUBLIC_KEY_PEM);
  });

  it('preserves benign 40-char, base64-looking, and secret-adjacent text across streaming writes', () => {
    const input = `hex=${HEX_LOOKALIKE} base62=${BASE62_LOOKALIKE} payload: ${QA_BENIGN_BASE64} secretary=delta monkey=epsilon\ncert=${CERTIFICATE_PEM}\npub=${PUBLIC_KEY_PEM}`;
    const redactor = createStreamingTextRedactor();
    const output = redactor.write(input.slice(0, 80)) + redactor.write(input.slice(80)) + redactor.flush();

    expect(output).toBe(input);
    expect(output).not.toContain('[REDACTED]');
  });
});
