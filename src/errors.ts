/** Structured domain error with a machine-readable code and optional details. */
export class CrontickError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CrontickError';
    this.code = code;
    this.details = details;
    // Maintain proper prototype chain so `instanceof CrontickError` works after transpilation
    Object.setPrototypeOf(this, CrontickError.prototype);
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
