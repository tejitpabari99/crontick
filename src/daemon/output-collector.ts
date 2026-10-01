/**
 * Streaming engine-output trimmer. Engine stdout is consumed line by line as
 * it arrives and everything except the final `result` event is discarded
 * immediately, so memory does not grow with stream length: only the final
 * result (one line) and the full stderr are retained. There is no line-size
 * limit (a line is held only until its newline arrives).
 *
 * Non-event stdout (plain-text engines and scripts) is the "result" of a text
 * run; it is kept under a byte cap (`retention.maxOutputBytesPerRun`).
 */
import { StringDecoder } from 'node:string_decoder';
import { asRecord, cleanOutputText, type EngineOutput } from '../run-output.js';

/** Marker line appended exactly once when a text run's captured stdout hits the cap. */
export function truncationMarker(maxBytes: number): string {
  return `\n[crontick] output truncated: exceeded ${maxBytes} bytes (retention.maxOutputBytesPerRun); further output from this run is not stored\n`;
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

export class EngineOutputCollector {
  private readonly stdoutDecoder = new StringDecoder('utf8');
  private readonly stderrDecoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private stderrText = '';
  private sawEvents = false;
  private sawStdout = false;
  private resultLine: string | undefined;
  private resultText: string | undefined;
  private resultIsError = false;
  private plain = '';
  private plainBytes = 0;
  private plainTruncated = false;

  /**
   * @param maxPlainBytes byte cap for plain (non-event) stdout.
   * @param onLine called with every complete stdout line before it is discarded.
   */
  constructor(
    private readonly maxPlainBytes: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  /** True once plain stdout hit the byte cap. */
  get truncated(): boolean {
    return this.plainTruncated;
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
    this.stderrText += this.stderrDecoder.write(chunk);
  }

  /** Flush decoders and a final unterminated stdout line. Call once at process close. */
  end(): void {
    this.lineBuffer += this.stdoutDecoder.end();
    this.stderrText += this.stderrDecoder.end();
    if (this.lineBuffer !== '') this.handleLine(this.lineBuffer);
    this.lineBuffer = '';
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') return;
    let event: Record<string, unknown> | undefined;
    if (line.trimStart().startsWith('{')) {
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        event = undefined;
      }
    }
    if (!event || typeof event['type'] !== 'string') {
      this.addPlain(line);
      return;
    }
    this.sawEvents = true;
    // Every other event type (system/init, assistant, user/tool results, stream_event) is dropped here.
    if (event['type'] === 'result') {
      this.resultLine = line.trim();
      this.resultText = typeof event['result'] === 'string' ? event['result'] : undefined;
      this.resultIsError = event['is_error'] === true;
    }
  }

  private addPlain(line: string): void {
    if (this.plainTruncated) return;
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.plainBytes + bytes <= this.maxPlainBytes) {
      this.plain += text;
      this.plainBytes += bytes;
      return;
    }
    const room = Math.max(0, this.maxPlainBytes - this.plainBytes);
    if (room > 0) this.plain += truncateToUtf8Boundary(Buffer.from(text, 'utf8').subarray(0, room)).toString('utf8');
    this.plain += truncationMarker(this.maxPlainBytes);
    this.plainTruncated = true;
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
