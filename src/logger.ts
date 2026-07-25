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

const SECRET_KEY = /(?:token|secret|password|credential|apikey|api_key|authorization|cookie)/i;
const SECRET_PATTERNS = [
  /(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GCLOUD_SERVICE_KEY|GOOGLE_CREDENTIALS|API_KEY|PASSWORD|TOKEN|SECRET)=[^\s]*/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return new CoreLogger(
    options.level ?? (options.verbose ? 'debug' : 'info'),
    options.verbose ?? options.level === 'debug',
    options.sink,
    options.component,
  );
}

export function isVerboseEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['CRONTICK_VERBOSE'];
  return typeof value === 'string' && /^(1|true|yes|on|debug)$/i.test(value.trim());
}

export function redactText(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
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
