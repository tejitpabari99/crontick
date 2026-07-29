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

/** Matches env-var-style secret keys for value-level redaction. */
const SECRET_KEY = /(?:token|secret|password|passwd|credential|apikey|api_key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|cookie|subscription[_-]?key)/i;
/** Patterns applied to log text to strip tokens/keys before they reach the sink. */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED]',
  },
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /(mongodb(?:\+srv)?):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    replacement: '$1://$2:[REDACTED]@',
  },
  {
    pattern: /(postgres(?:ql)?):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    replacement: '$1://$2:[REDACTED]@',
  },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[REDACTED]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, replacement: '[REDACTED]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' },
  {
    pattern: /(\b[\w.-]*?(?:token|secret|password|passwd|api(?:[_-]?key)?|credential|private[_-]?key|cookie|subscription[_-]?key)[\w.-]*\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    replacement: '$1[REDACTED]',
  },
];

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
  return output;
}

export function redactValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY.test(keyHint)) return '[REDACTED]';
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
