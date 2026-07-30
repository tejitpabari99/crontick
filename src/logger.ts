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

const REDACTED = '[REDACTED]';

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
const STANDALONE_AWS_SECRET_CANDIDATE = /(^|[^A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?=$|[^A-Za-z0-9/+=])/g;

/** Patterns applied to log text to strip tokens/keys before they reach the sink. */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
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
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
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

function isAwsSecretAccessKeyCandidate(value: string): boolean {
  return /^[A-Za-z0-9/+=]{40}$/.test(value)
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /\d/.test(value)
    && /[/+=]/.test(value)
    && !/^[0-9a-f]{40}$/i.test(value);
}

function redactStandaloneAwsSecretAccessKeys(text: string): string {
  return text.replace(STANDALONE_AWS_SECRET_CANDIDATE, (match, prefix: string, candidate: string) => (
    isAwsSecretAccessKeyCandidate(candidate) ? `${prefix}${REDACTED}` : match
  ));
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

function isAsciiWhitespace(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
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
    if (isAsciiWhitespace(char) || char === ',' || char === ';') return end;
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


/** Reads CRONTICK_VERBOSE; accepts 1|true|yes|on|debug (case-insensitive). */
export function isVerboseEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['CRONTICK_VERBOSE'];
  return typeof value === 'string' && /^(1|true|yes|on|debug)$/i.test(value.trim());
}

export function redactText(text: string): string {
  let output = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  output = redactSecretAssignments(output);
  return redactStandaloneAwsSecretAccessKeys(output);
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
