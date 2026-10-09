// Minimal hand-written SSE client over an injected `fetch` (Node 22 has no global
// EventSource and no new dependencies are allowed). No Last-Event-ID, no replay:
// relay ids are per-connection counters and the relay stores nothing.

export interface SseEvent {
  id: string | undefined;
  /** Event name; defaults to `message`. Callers decide what to ignore (`ready`, `ping`). */
  event: string;
  /** `data:` lines joined by `\n`. */
  data: string;
}

export interface SseOptions {
  onEvent(event: SseEvent): void;
  signal: AbortSignal;
  fetch: typeof fetch;
  /** Called for every body chunk received (including comments); used for idle watchdogs. */
  onActivity?(): void;
}

/**
 * Connect and dispatch events until the stream ends (resolves) or fails (rejects).
 * Rejects on non-200, non-`text/event-stream` content type, or missing body.
 */
export async function connectSse(url: string, opts: SseOptions): Promise<void> {
  const res = await opts.fetch(url, { headers: { Accept: 'text/event-stream' }, signal: opts.signal });
  if (res.status !== 200) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/event-stream')) {
    throw new Error(`SSE connect failed: expected text/event-stream, got "${type}"`);
  }
  if (!res.body) throw new Error('SSE connect failed: response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let id: string | undefined;
  let eventName = '';
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length > 0) opts.onEvent({ id, event: eventName || 'message', data: data.join('\n') });
    eventName = '';
    data = [];
  };

  const handleLine = (line: string): void => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      opts.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r\n|\n|\r/.exec(buffer)) !== null) {
        // A lone trailing \r may be the first half of \r\n; wait for more input.
        if (m[0] === '\r' && m.index === buffer.length - 1) break;
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        handleLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
