export class CrontickError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CrontickError';
    this.code = code;
    this.details = details;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, CrontickError.prototype);
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
