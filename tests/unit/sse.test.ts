import { describe, it, expect } from 'vitest';
import { connectSse, type SseEvent } from '../../src/daemon/sse.js';

const enc = new TextEncoder();

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

function fakeFetch(body: ReadableStream<Uint8Array> | null, init: { status?: number; type?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, i: RequestInit) => {
    calls.push({ url, init: i });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'text/event-stream; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function collect(chunks: Array<string | Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const { fn } = fakeFetch(streamOf(chunks));
  await connectSse('http://127.0.0.1/x', { onEvent: (e) => events.push(e), signal: new AbortController().signal, fetch: fn });
  return events;
}

describe('connectSse', () => {
  it('sends Accept header and signal, no Last-Event-ID', async () => {
    const { fn, calls } = fakeFetch(streamOf([]));
    const signal = new AbortController().signal;
    await connectSse('http://127.0.0.1/x', { onEvent: () => {}, signal, fetch: fn });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers['Last-Event-ID']).toBeUndefined();
    expect(calls[0]!.init.signal).toBe(signal);
  });

  it('parses id/event/data and defaults event to message', async () => {
    const ev = await collect(['id: 7\nevent: ping\ndata: {"a":1}\n\ndata: hi\n\n']);
    expect(ev).toEqual([
      { id: '7', event: 'ping', data: '{"a":1}' },
      { id: '7', event: 'message', data: 'hi' },
    ]);
  });

  it('joins multi-line data with newline', async () => {
    const ev = await collect(['data: a\ndata: b\ndata:c\n\n']);
    expect(ev[0]!.data).toBe('a\nb\nc');
  });

  it('ignores comments and surfaces ready/ping', async () => {
    const ev = await collect([': keepalive\n\nevent: ready\ndata: {}\n\n: c\nevent: ping\ndata: {}\n\n']);
    expect(ev.map((e) => e.event)).toEqual(['ready', 'ping']);
  });

  it('handles chunk splits mid-line', async () => {
    const ev = await collect(['da', 'ta: hel', 'lo\n', '\nda', 'ta: two\n', '\n']);
    expect(ev.map((e) => e.data)).toEqual(['hello', 'two']);
  });

  it('handles chunk splits mid-UTF-8 character', async () => {
    const bytes = enc.encode('data: héllo €\n\n');
    for (let i = 1; i < bytes.length; i++) {
      const ev = await collect([bytes.slice(0, i), bytes.slice(i)]);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.data).toBe('héllo €');
    }
  });

  it('handles CRLF and flushes nothing for an incomplete trailing event', async () => {
    const ev = await collect(['data: a\r\n\r\ndata: b\r\n\r\ndata: partial']);
    expect(ev.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('skips events with no data', async () => {
    expect(await collect(['event: x\n\n'])).toEqual([]);
  });

  it('rejects on non-200', async () => {
    const { fn } = fakeFetch(streamOf([]), { status: 503 });
    await expect(connectSse('http://h/x', { onEvent: () => {}, signal: new AbortController().signal, fetch: fn })).rejects.toThrow(/503/);
  });

  it('rejects on wrong content type', async () => {
    const { fn } = fakeFetch(streamOf(['data: x\n\n']), { type: 'text/html' });
    await expect(connectSse('http://h/x', { onEvent: () => {}, signal: new AbortController().signal, fetch: fn })).rejects.toThrow(/text\/event-stream/);
  });

  it('rejects when response has no body', async () => {
    const fn = (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: null })) as unknown as typeof fetch;
    await expect(connectSse('http://h/x', { onEvent: () => {}, signal: new AbortController().signal, fetch: fn })).rejects.toThrow(/body/);
  });
});
