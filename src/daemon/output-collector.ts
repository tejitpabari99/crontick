/**
 * Streaming engine-output trimmer. When the selected engine adapter supplies a
 * stream-event parser (`EngineAdapter.parseStreamEvent`, Claude stream-json),
 * stdout is consumed line by line as it arrives and everything except the final
 * `result` event is discarded immediately, so memory does not grow with stream
 * length. There is no line-size limit (a line is held only until its newline
 * arrives).
 *
 * Without a parser (the generic default, used by raw engines) every stdout
 * line is plain output: it is the "result" of a text run and is kept under a
 * byte cap (`retention.maxOutputBytesPerRun`). JSON that merely looks like an
 * event (`{"type":"assistant",...}`) is never interpreted for such engines.
 *
 * stderr is kept under its own byte cap (`DEFAULT_MAX_STDERR_BYTES_PER_RUN`).
 */
import { StringDecoder } from 'node:string_decoder';
import { cleanOutputText, type EngineOutput } from '../run-output.js';
import type { StreamEvent } from '../engines/types.js';
import { DEFAULT_MAX_STDERR_BYTES_PER_RUN } from '../constants/retention.js';

/** Marker line appended exactly once when a captured stream hits its cap. */
export function truncationMarker(maxBytes: number, source = 'output', setting = 'retention.maxOutputBytesPerRun'): string {
  return `\n[crontick] ${source} truncated: exceeded ${maxBytes} bytes (${setting}); further ${source} from this run is not stored\n`;
}

/**
 * Trims trailing bytes that would split a multi-byte UTF-8 character in two,
 * so a byte-offset cut never leaves an invalid sequence before the marker.
 */
export function truncateToUtf8Boundary(buf: Buffer): Buffer {
  const len = buf.length;
  if (len === 0) return buf;
  const scanStart = Math.max(0, len - 4); // longest UTF-8 sequence is 4 bytes
  for (let i = len - 1; i >= scanStart; i--) {
    const byte = buf[i]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep scanning back for its lead byte
    let seqLen: number;
    if ((byte & 0x80) === 0x00) seqLen = 1;
    else if ((byte & 0xe0) === 0xc0) seqLen = 2;
    else if ((byte & 0xf0) === 0xe0) seqLen = 3;
    else if ((byte & 0xf8) === 0xf0) seqLen = 4;
    else return buf; // not a valid UTF-8 lead byte: leave untouched
    return i + seqLen <= len ? buf : buf.subarray(0, i);
  }
  return buf;
}

/** Accumulates text under a byte cap; on overflow cuts at a UTF-8 boundary and appends one marker. */
class BoundedText {
  text = '';
  truncated = false;
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly marker: string,
  ) {}

  add(text: string): void {
    if (this.truncated) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.bytes + bytes <= this.maxBytes) {
      this.text += text;
      this.bytes += bytes;
      return;
    }
    const room = Math.max(0, this.maxBytes - this.bytes);
    if (room > 0) this.text += truncateToUtf8Boundary(Buffer.from(text, 'utf8').subarray(0, room)).toString('utf8');
    this.text += this.marker;
    this.truncated = true;
  }
}

export interface EngineOutputCollectorOptions {
  /** Adapter-specific stream-event parser; omit for generic plain-text handling. */
  parseEvent?: (line: string) => StreamEvent | undefined;
  /** Byte cap for stderr (default `DEFAULT_MAX_STDERR_BYTES_PER_RUN`). */
  maxStderrBytes?: number;
}

export class EngineOutputCollector {
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private sawEvents = false;
  private sawStdout = false;
  private resultLine: string | undefined;
  private resultText: string | undefined;
  private resultIsError = false;
  private readonly plainText: BoundedText;
  private readonly stderrBuf: BoundedText;
  private readonly parseEvent: ((line: string) => StreamEvent | undefined) | undefined;

  /**
   * @param maxPlainBytes byte cap for plain (non-event) stdout.
   * @param onLine called with every complete stdout line before it is discarded.
   * @param options adapter stream-event parser and stderr cap.
   */
  constructor(
    maxPlainBytes: number,
    private readonly onLine?: (line: string) => void,
    options: EngineOutputCollectorOptions = {},
  ) {
    this.parseEvent = options.parseEvent;
    this.plainText = new BoundedText(maxPlainBytes, truncationMarker(maxPlainBytes));
    const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES_PER_RUN;
    this.stderrBuf = new BoundedText(maxStderr, truncationMarker(maxStderr, 'stderr', 'DEFAULT_MAX_STDERR_BYTES_PER_RUN'));
  }

  /** True once plain stdout or stderr hit its byte cap. */
  get truncated(): boolean {
    return this.plainText.truncated || this.stderrBuf.truncated;
  }

  private get plain(): string {
    return this.plainText.text;
  }

  private get stderrText(): string {
    return this.stderrBuf.text;
  }

  pushStdout(chunk: Buffer): void {
    this.sawStdout = true;
    this.lineBuffer += this.stdoutDecoder.write(chunk);
    let newline = this.lineBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.handleLine(line);
      this.onLine?.(line);
      newline = this.lineBuffer.indexOf('\n');
    }
  }

  pushStderr(chunk: Buffer): void {
    this.stderrBuf.add(this.stderrDecoder.write(chunk));
  }

  /** Flush decoders and a final unterminated stdout line. Call once at process close. */
  end(): void {
    this.lineBuffer += this.stdoutDecoder.end();
    this.stderrBuf.add(this.stderrDecoder.end());
    if (this.lineBuffer !== '') this.handleLine(this.lineBuffer);
    this.lineBuffer = '';
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') return;
    const event = this.parseEvent?.(line);
    if (!event) {
      this.plainText.add(`${line}\n`);
      return;
    }
    this.sawEvents = true;
    // Every other event type (system/init, assistant, user/tool results, stream_event) is dropped here.
    if (event.type === 'result') {
      this.resultLine = line.trim();
      this.resultText = event.result;
      this.resultIsError = event.isError === true;
    }
  }

  /** True when the engine produced any stdout or stderr. */
  hasOutput(): boolean {
    return this.sawStdout || this.stderrText !== '';
  }

  /** What `adapter.parseResult` should see: the final result line when present, else plain stdout. Stderr is full. */
  parseSource(): { stdout: string; stderr: string } {
    return { stdout: this.resultLine ?? this.plain, stderr: this.stderrText };
  }

  /** The persisted view; undefined when the engine produced no output at all. */
  toEngineOutput(): EngineOutput | undefined {
    if (!this.hasOutput()) return undefined;
    const format: EngineOutput['format'] = this.sawEvents ? 'claude-stream-json' : 'text';
    let result: string | undefined;
    if (format === 'claude-stream-json') {
      result = !this.resultIsError && this.resultText !== undefined && this.resultText !== '' ? this.resultText : undefined;
    } else {
      const text = this.plain.trim();
      result = text === '' ? undefined : text;
    }
    const engineError = this.resultIsError ? this.resultText : undefined;
    return {
      format,
      result: result === undefined ? null : cleanOutputText(result),
      engineError: engineError === undefined ? null : cleanOutputText(engineError),
      stderr: cleanOutputText(this.stderrText.trim()),
    };
  }
}
