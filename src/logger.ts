/**
 * Structured logging with secret redaction. Four levels (error, warn, info, debug)
 * and a sink-based architecture: each surface provides its own sink (file, stderr, array).
 * All log events are sanitized before emission to strip known secret patterns.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEvent {
  ts: string;
  level: LogLevel;
  component?: string;
  message: string;
  data?: unknown;
}

export type LogSink = (event: LogEvent) => void;

export interface LoggerOptions {
  verbose?: boolean;
  level?: LogLevel;
  component?: string;
  sink?: LogSink;
}

export interface Logger {
  readonly level: LogLevel;
  readonly verbose: boolean;
  isEnabled(level: LogLevel): boolean;
  isDebugEnabled(): boolean;
  child(component: string): Logger;
  log(level: LogLevel, message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

export interface StreamingTextRedactor {
  write(chunk: string): string;
  flush(): string;
}

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

type SecretPattern = {
  pattern: RegExp;
  replacement: string;
};

type TextMatch = {
  index: number;
  end: number;
};

type SecretAssignmentQuote = '"' | "'" | null;

type SensitiveAssignmentMatch = {
  keyStart: number;
  valueStart: number;
  quote: SecretAssignmentQuote;
};

const REDACTED = '[REDACTED]';
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_BEGIN_MARKER_PATTERN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_END_MARKER_PATTERN = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_ANY_MARKER_PATTERN = /-----(?:BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const EXACT_PRIVATE_KEY_BEGIN_MARKER = /^-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----$/;
const EXACT_PRIVATE_KEY_END_MARKER = /^-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----$/;
const PRIVATE_KEY_BEGIN_PREFIX = '-----BEGIN ';
const PRIVATE_KEY_END_PREFIX = '-----END ';
const PRIVATE_KEY_MARKER_SUFFIX = 'PRIVATE KEY-----';
const MAX_PRIVATE_KEY_MARKER_LABEL_LENGTH = 40;
const MAX_SECRET_ASSIGNMENT_CARRY = 256;
const MAX_AWS_ACCESS_KEY_PAIR_GAP = 12;
const MAX_AWS_ACCESS_KEY_PAIR_CARRY = 128;

const SENSITIVE_KEY_SUFFIXES: ReadonlyArray<ReadonlyArray<string>> = [
  ['token'],
  ['secret'],
  ['password'],
  ['passwd'],
  ['credential'],
  ['credentials'],
  ['authorization'],
  ['cookie'],
  ['api', 'key'],
  ['client', 'secret'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['private', 'key'],
  ['secret', 'key'],
  ['secret', 'access', 'key'],
  ['subscription', 'key'],
];

const NEGATED_SENSITIVE_PREFIXES = new Set(['no', 'non', 'not']);
const AWS_ACCESS_KEY_ID_PATTERN = /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g;
const AWS_ACCESS_KEY_ID_LINE_HINT = /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/;
const AWS_SECRET_ACCESS_KEY_CANDIDATE_PATTERN = /(^|[^A-Za-z0-9/+])([A-Za-z0-9/+=]{40})(?=$|[^A-Za-z0-9/+])/g;
const CONTEXTUAL_AWS_SECRET_ACCESS_KEY_LABEL_PATTERN = /(\b(?:aws[\s._-]*)?secret[\s._-]*access[\s._-]*key\b\s*[:=]\s*)(?:"([A-Za-z0-9/+=]{40})"|'([A-Za-z0-9/+=]{40})'|([A-Za-z0-9/+=]{40}))/gi;
const AWS_PAIR_SEPARATOR_PATTERN = /^[\s"'=:,;()[\]{}]{1,12}$/;
const AWS_SECRET_ACCESS_KEY_CANDIDATE_CHARS_PATTERN = /^[A-Za-z0-9/+=]+$/;

/** Patterns applied to log text to strip tokens/keys before they reach the sink. */
const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: PRIVATE_KEY_BLOCK_PATTERN, replacement: REDACTED },
  { pattern: PRIVATE_KEY_ANY_MARKER_PATTERN, replacement: REDACTED },
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern: /(mongodb(?:\+srv)?):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    replacement: `$1://$2:${REDACTED}@`,
  },
  {
    pattern: /(postgres(?:ql)?):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    replacement: `$1://$2:${REDACTED}@`,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, replacement: REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, replacement: REDACTED },
  { pattern: AWS_ACCESS_KEY_ID_PATTERN, replacement: REDACTED },
];

function normalizeKeyHint(keyHint: string): string[] {
  return keyHint
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function matchesSensitiveKeySuffix(tokens: readonly string[], suffix: readonly string[]): boolean {
  const start = tokens.length - suffix.length;
  if (start < 0) return false;
  for (let i = 0; i < suffix.length; i++) {
    if (tokens[start + i] !== suffix[i]) return false;
  }
  return !NEGATED_SENSITIVE_PREFIXES.has(tokens[start - 1] ?? '');
}

export function isSensitiveKeyHint(keyHint: string): boolean {
  const tokens = normalizeKeyHint(keyHint);
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => matchesSensitiveKeySuffix(tokens, suffix));
}

function matchesSensitiveKeyHintPrefix(tokens: readonly string[], suffix: readonly string[]): boolean {
  for (let start = 0; start < tokens.length; start++) {
    if (NEGATED_SENSITIVE_PREFIXES.has(tokens[start - 1] ?? '')) continue;
    const candidateLength = tokens.length - start;
    if (candidateLength > suffix.length) continue;
    let matches = true;
    for (let i = 0; i < candidateLength; i++) {
      const token = tokens[start + i]!;
      const expected = suffix[i]!;
      if (i === candidateLength - 1) {
        if (!expected.startsWith(token)) {
          matches = false;
          break;
        }
      } else if (token !== expected) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function couldBeSensitiveKeyHintPrefix(keyHint: string): boolean {
  const tokens = normalizeKeyHint(keyHint);
  return tokens.length > 0
    && SENSITIVE_KEY_SUFFIXES.some((suffix) => matchesSensitiveKeyHintPrefix(tokens, suffix));
}

function isAwsSecretAccessKeyCandidate(value: string): boolean {
  return /^[A-Za-z0-9/+=]{40}$/.test(value)
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /\d/.test(value)
    && /[/+=]/.test(value)
    && !/^[0-9a-f]{40}$/i.test(value);
}

function hasNearbyAwsAccessKeyId(line: string, candidateStart: number): boolean {
  AWS_ACCESS_KEY_ID_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AWS_ACCESS_KEY_ID_PATTERN.exec(line)) !== null) {
    const idEnd = match.index + match[0].length;
    if (idEnd >= candidateStart) continue;
    const gap = line.slice(idEnd, candidateStart);
    if (gap.length === 0 || gap.length > MAX_AWS_ACCESS_KEY_PAIR_GAP || !AWS_PAIR_SEPARATOR_PATTERN.test(gap)) continue;
    return true;
  }
  return false;
}

function findAwsAccessKeyPairCarry(text: string): string {
  const lineStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  const line = text.slice(lineStart);
  AWS_ACCESS_KEY_ID_PATTERN.lastIndex = 0;
  let carryStart = -1;
  let match: RegExpExecArray | null;
  while ((match = AWS_ACCESS_KEY_ID_PATTERN.exec(line)) !== null) {
    const idStart = match.index;
    const idEnd = idStart + match[0].length;
    const suffixLength = line.length - idStart;
    if (suffixLength > MAX_AWS_ACCESS_KEY_PAIR_CARRY) continue;

    let separatorEnd = idEnd;
    while (separatorEnd < line.length && /[\s"'=:,;()[\]{}]/.test(line[separatorEnd]!)) separatorEnd++;
    const gap = line.slice(idEnd, separatorEnd);
    if (gap.length === 0 || gap.length > MAX_AWS_ACCESS_KEY_PAIR_GAP || !AWS_PAIR_SEPARATOR_PATTERN.test(gap)) continue;

    const candidatePrefix = line.slice(separatorEnd);
    if (candidatePrefix.length === 0
      || (candidatePrefix.length < 40 && AWS_SECRET_ACCESS_KEY_CANDIDATE_CHARS_PATTERN.test(candidatePrefix))) {
      carryStart = idStart;
    }
  }
  return carryStart >= 0 ? line.slice(carryStart) : '';
}

function redactIncompleteAwsAccessKeyPairCarry(carry: string): string {
  const match = AWS_ACCESS_KEY_ID_LINE_HINT.exec(carry);
  if (!match || match.index !== 0) return redactText(carry);

  const idEnd = match[0].length;
  let separatorEnd = idEnd;
  while (separatorEnd < carry.length && /[\s"'=:,;()[\]{}]/.test(carry[separatorEnd]!)) separatorEnd++;
  const gap = carry.slice(idEnd, separatorEnd);
  const candidatePrefix = carry.slice(separatorEnd);

  if (gap.length > 0 && gap.length <= MAX_AWS_ACCESS_KEY_PAIR_GAP && AWS_PAIR_SEPARATOR_PATTERN.test(gap)) {
    if (candidatePrefix.length === 0) return `${REDACTED}${gap}`;
    if (candidatePrefix.length < 40 && AWS_SECRET_ACCESS_KEY_CANDIDATE_CHARS_PATTERN.test(candidatePrefix)) {
      return `${REDACTED}${gap}${REDACTED}`;
    }
  }

  return redactText(carry);
}

function redactTextWithStreamingAwsPairFlush(text: string): string {
  const carry = findAwsAccessKeyPairCarry(text);
  if (!carry) return redactText(text);
  return `${redactText(text.slice(0, text.length - carry.length))}${redactIncompleteAwsAccessKeyPairCarry(carry)}`;
}

function redactAwsSecretAccessKeysNearAccessKeyIds(text: string): string {
  return text.replace(/^.*$/gm, (line) => {
    if (!AWS_ACCESS_KEY_ID_LINE_HINT.test(line)) return line;
    return line.replace(AWS_SECRET_ACCESS_KEY_CANDIDATE_PATTERN, (match, prefix: string, candidate: string, offset: number) => {
      const candidateStart = offset + prefix.length;
      return isAwsSecretAccessKeyCandidate(candidate) && hasNearbyAwsAccessKeyId(line, candidateStart)
        ? `${prefix}${REDACTED}`
        : match;
    });
  });
}

function redactContextualAwsSecretAccessKeyLabels(text: string): string {
  return text.replace(
    CONTEXTUAL_AWS_SECRET_ACCESS_KEY_LABEL_PATTERN,
    (match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const candidate = doubleQuoted ?? singleQuoted ?? bare;
      if (!candidate || !isAwsSecretAccessKeyCandidate(candidate)) return match;
      if (doubleQuoted !== undefined) return `${prefix}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${prefix}'${REDACTED}'`;
      return `${prefix}${REDACTED}`;
    },
  );
}

function isSecretAssignmentKeyChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === '_'
    || char === '-'
    || char === '.';
}

function isQuotedSecretAssignmentKeyChar(char: string | undefined): boolean {
  return char === ' ' || isSecretAssignmentKeyChar(char);
}

function isPrivateKeyMarkerLabelChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return char === ' ' || (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

function isAsciiWhitespace(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}

function isSecretAssignmentValueTerminator(char: string | undefined): boolean {
  return isAsciiWhitespace(char) || char === ',' || char === ';';
}

function scanSecretAssignmentValueEnd(text: string, start: number): number {
  if (start >= text.length) return start;
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    let end = start + 1;
    while (end < text.length) {
      const char = text[end];
      if (char === quote) return end + 1;
      if (char === '\r' || char === '\n') return end;
      end++;
    }
    return end;
  }
  let end = start;
  while (end < text.length) {
    const char = text[end];
    if (isSecretAssignmentValueTerminator(char)) return end;
    end++;
  }
  return end;
}

function scanSecretAssignmentKey(text: string, start: number): { key: string; end: number } | undefined {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    let end = start + 1;
    while (end < text.length && text[end] !== quote) {
      if (!isQuotedSecretAssignmentKeyChar(text[end])) return undefined;
      end++;
    }
    if (end >= text.length || text[end] !== quote) return undefined;
    const key = text.slice(start + 1, end);
    return key ? { key, end: end + 1 } : undefined;
  }

  if (!isSecretAssignmentKeyChar(text[start]) || isSecretAssignmentKeyChar(text[start - 1])) {
    return undefined;
  }

  let end = start + 1;
  while (end < text.length && isSecretAssignmentKeyChar(text[end])) end++;
  return { key: text.slice(start, end), end };
}

function matchesPrivateKeyMarker(text: string, kind: 'begin' | 'end'): boolean {
  return (kind === 'begin' ? EXACT_PRIVATE_KEY_BEGIN_MARKER : EXACT_PRIVATE_KEY_END_MARKER).test(text);
}

function isPossiblePrivateKeyMarkerBodyPrefix(text: string): boolean {
  if (text.length > MAX_PRIVATE_KEY_MARKER_LABEL_LENGTH + PRIVATE_KEY_MARKER_SUFFIX.length) {
    return false;
  }
  for (let split = 0; split <= text.length; split++) {
    const label = text.slice(0, split);
    if (label.length > MAX_PRIVATE_KEY_MARKER_LABEL_LENGTH) break;
    const suffix = text.slice(split);
    if ([...label].every((char) => isPrivateKeyMarkerLabelChar(char)) && PRIVATE_KEY_MARKER_SUFFIX.startsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function isPossiblePrivateKeyMarkerPrefix(text: string, kind: 'begin' | 'end'): boolean {
  if (!text || matchesPrivateKeyMarker(text, kind)) return false;
  const prefix = kind === 'begin' ? PRIVATE_KEY_BEGIN_PREFIX : PRIVATE_KEY_END_PREFIX;
  if (prefix.startsWith(text)) return true;
  if (!text.startsWith(prefix)) return false;
  return isPossiblePrivateKeyMarkerBodyPrefix(text.slice(prefix.length));
}

function findPrivateKeyMarkerCarry(text: string, allowBegin: boolean, allowEnd: boolean): string {
  if (/-----(?:BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY-----$/.test(text)) return '';
  let start = text.lastIndexOf('-');
  while (start >= 0) {
    const suffix = text.slice(start);
    if ((allowBegin && isPossiblePrivateKeyMarkerPrefix(suffix, 'begin'))
      || (allowEnd && isPossiblePrivateKeyMarkerPrefix(suffix, 'end'))) {
      return suffix;
    }
    if (start === 0) break;
    start = text.lastIndexOf('-', start - 1);
  }
  return '';
}

function findNextSensitiveAssignmentStart(text: string, start = 0): SensitiveAssignmentMatch | undefined {
  let cursor = start;
  while (cursor < text.length) {
    const scanned = scanSecretAssignmentKey(text, cursor);
    if (!scanned) {
      cursor++;
      continue;
    }
    const { key, end: keyEnd } = scanned;
    if (isSensitiveKeyHint(key)) {
      let separatorStart = keyEnd;
      while (separatorStart < text.length && isAsciiWhitespace(text[separatorStart])) separatorStart++;
      const separator = text[separatorStart];
      if (separator === '=' || separator === ':') {
        let valueStart = separatorStart + 1;
        while (valueStart < text.length && isAsciiWhitespace(text[valueStart])) valueStart++;
        if (valueStart < text.length) {
          const quote = text[valueStart];
          return {
            keyStart: cursor,
            valueStart,
            quote: quote === '"' || quote === "'" ? quote : null,
          };
        }
      }
    }
    cursor = keyEnd;
  }
  return undefined;
}

function findSecretAssignmentCarry(text: string): string {
  const minStart = Math.max(0, text.length - MAX_SECRET_ASSIGNMENT_CARRY);
  let candidateStart = -1;
  let cursor = minStart;
  while (cursor < text.length) {
    const scanned = scanSecretAssignmentKey(text, cursor);
    if (!scanned) {
      cursor++;
      continue;
    }
    const { key, end: keyEnd } = scanned;
    let carry = false;
    if (keyEnd === text.length) {
      carry = couldBeSensitiveKeyHintPrefix(key);
    } else {
      let separatorStart = keyEnd;
      while (separatorStart < text.length && isAsciiWhitespace(text[separatorStart])) separatorStart++;
      if (separatorStart >= text.length) {
        carry = isSensitiveKeyHint(key) || couldBeSensitiveKeyHintPrefix(key);
      } else {
        const separator = text[separatorStart];
        if ((separator === '=' || separator === ':') && isSensitiveKeyHint(key)) {
          let valueStart = separatorStart + 1;
          while (valueStart < text.length && isAsciiWhitespace(text[valueStart])) valueStart++;
          carry = valueStart >= text.length;
        }
      }
    }
    if (carry) candidateStart = cursor;
    cursor = keyEnd;
  }
  return candidateStart >= 0 ? text.slice(candidateStart) : '';
}

function findStreamingRedactionCarry(text: string): string {
  const carries = [
    findPrivateKeyMarkerCarry(text, true, true),
    findSecretAssignmentCarry(text),
    findAwsAccessKeyPairCarry(text),
  ];
  return carries.reduce((longest, carry) => (carry.length > longest.length ? carry : longest), '');
}

function findNextMatch(pattern: RegExp, text: string, start = 0): TextMatch | undefined {
  pattern.lastIndex = start;
  const match = pattern.exec(text);
  if (!match) return undefined;
  return {
    index: match.index,
    end: match.index + match[0].length,
  };
}

class PrivateKeyStreamingTextRedactor implements StreamingTextRedactor {
  private carry = '';
  private insidePrivateKeyBlock = false;
  private pendingSecretAssignmentQuote: SecretAssignmentQuote | undefined;

  write(chunk: string): string {
    if (chunk.length === 0) return '';
    return this.process(`${this.carry}${chunk}`, false);
  }

  flush(): string {
    const output = this.process(this.carry, true);
    this.carry = '';
    this.insidePrivateKeyBlock = false;
    this.pendingSecretAssignmentQuote = undefined;
    return output;
  }

  private process(text: string, flush: boolean): string {
    let output = '';
    let cursor = 0;

    while (cursor < text.length) {
      if (this.insidePrivateKeyBlock) {
        const endMatch = findNextMatch(PRIVATE_KEY_END_MARKER_PATTERN, text, cursor);
        if (!endMatch) {
          this.carry = flush ? '' : findPrivateKeyMarkerCarry(text.slice(cursor), false, true);
          return output;
        }
        this.insidePrivateKeyBlock = false;
        cursor = endMatch.end;
        continue;
      }

      if (this.pendingSecretAssignmentQuote !== undefined) {
        const secretEnd = this.findPendingSecretAssignmentEnd(text, cursor);
        if (!secretEnd) {
          if (flush) this.pendingSecretAssignmentQuote = undefined;
          this.carry = '';
          return output;
        }
        output += secretEnd.closingQuote;
        this.pendingSecretAssignmentQuote = undefined;
        cursor = secretEnd.cursor;
        continue;
      }

      const beginMatch = findNextMatch(PRIVATE_KEY_BEGIN_MARKER_PATTERN, text, cursor);
      const secretMatch = findNextSensitiveAssignmentStart(text, cursor);
      if (!beginMatch && !secretMatch) {
        const remaining = text.slice(cursor);
        if (flush) {
          output += redactTextWithStreamingAwsPairFlush(remaining);
          this.carry = '';
          return output;
        }
        const carry = findStreamingRedactionCarry(remaining);
        output += redactText(remaining.slice(0, remaining.length - carry.length));
        this.carry = carry;
        return output;
      }

      if (secretMatch && (!beginMatch || secretMatch.keyStart < beginMatch.index)) {
        output += redactText(text.slice(cursor, secretMatch.keyStart));
        const valuePrefixEnd = secretMatch.quote === null ? secretMatch.valueStart : secretMatch.valueStart + 1;
        output += text.slice(secretMatch.keyStart, valuePrefixEnd);
        output += REDACTED;
        this.pendingSecretAssignmentQuote = secretMatch.quote;
        cursor = valuePrefixEnd;
        continue;
      }

      output += redactText(text.slice(cursor, beginMatch!.index));
      output += REDACTED;
      this.insidePrivateKeyBlock = true;
      cursor = beginMatch!.end;
    }

    this.carry = '';
    return output;
  }

  private findPendingSecretAssignmentEnd(
    text: string,
    start: number,
  ): { cursor: number; closingQuote: string } | undefined {
    const quote = this.pendingSecretAssignmentQuote;
    let cursor = start;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote === null) {
        if (isSecretAssignmentValueTerminator(char)) {
          return { cursor, closingQuote: '' };
        }
      } else {
        if (char === quote) {
          return { cursor: cursor + 1, closingQuote: quote };
        }
        if (char === '\r' || char === '\n') {
          return { cursor, closingQuote: '' };
        }
      }
      cursor++;
    }
    return undefined;
  }
}

function redactSecretAssignments(text: string): string {
  let output = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const scanned = scanSecretAssignmentKey(text, i);
    if (scanned) {
      const { key, end: keyEnd } = scanned;
      if (isSensitiveKeyHint(key)) {
        let separatorStart = keyEnd;
        while (separatorStart < text.length && isAsciiWhitespace(text[separatorStart])) separatorStart++;
        const separator = text[separatorStart];
        if (separator === '=' || separator === ':') {
          let valueStart = separatorStart + 1;
          while (valueStart < text.length && isAsciiWhitespace(text[valueStart])) valueStart++;
          const valueEnd = scanSecretAssignmentValueEnd(text, valueStart);
          if (valueEnd > valueStart) {
            const valueQuote = text[valueStart];
            const quoted = (valueQuote === '"' || valueQuote === "'") && text[valueEnd - 1] === valueQuote;
            if (quoted) {
              output += text.slice(cursor, valueStart + 1);
              output += REDACTED;
              output += valueQuote;
            } else {
              output += text.slice(cursor, valueStart);
              output += REDACTED;
            }
            cursor = valueEnd;
            i = valueEnd;
            continue;
          }
        }
      }
      i = keyEnd;
      continue;
    }
    i++;
  }
  return cursor === 0 ? text : `${output}${text.slice(cursor)}`;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new CoreLogger(
    options.level ?? (options.verbose ? 'debug' : 'info'),
    options.verbose ?? options.level === 'debug',
    options.sink,
    options.component,
  );
}

export function createStreamingTextRedactor(): StreamingTextRedactor {
  return new PrivateKeyStreamingTextRedactor();
}

/** Reads CRONTICK_VERBOSE; accepts 1|true|yes|on|debug (case-insensitive). */
export function isVerboseEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['CRONTICK_VERBOSE'];
  return typeof value === 'string' && /^(1|true|yes|on|debug)$/i.test(value.trim());
}

export function redactText(text: string): string {
  let output = redactAwsSecretAccessKeysNearAccessKeyIds(text);
  output = redactContextualAwsSecretAccessKeyLabels(output);
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  output = redactSecretAssignments(output);
  return output;
}

export function redactValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && isSensitiveKeyHint(keyHint)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(entry, key);
    }
    return out;
  }
  return String(value);
}

export function sanitizeLogEvent(event: LogEvent): LogEvent {
  return {
    ts: event.ts,
    level: event.level,
    component: event.component,
    message: redactText(event.message),
    ...(event.data === undefined ? {} : { data: redactValue(event.data) }),
  };
}

class CoreLogger implements Logger {
  constructor(
    readonly level: LogLevel,
    readonly verbose: boolean,
    private readonly sink?: LogSink,
    private readonly component?: string,
  ) {}

  isEnabled(level: LogLevel): boolean {
    return LEVELS[level] <= LEVELS[this.level];
  }

  isDebugEnabled(): boolean {
    return this.isEnabled('debug');
  }

  child(component: string): Logger {
    const next = this.component ? `${this.component}.${component}` : component;
    return new CoreLogger(this.level, this.verbose, this.sink, next);
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.isEnabled(level)) return;
    const event = sanitizeLogEvent({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
      data,
    });
    try {
      this.sink?.(event);
    } catch {
      // Logging must never break crontick behavior.
    }
  }
  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }
}

export const nullLogger: Logger = createLogger({ level: 'error' });
