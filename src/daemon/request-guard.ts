// Request guard for every mutating daemon API route (DNS-rebinding / cross-site defense).
// Applied centrally by method in api.ts, so a new mutating route cannot skip it.
import type http from 'node:http';

export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface GuardRejection {
  status: number;
  message: string;
}

/** True when `/api` mutating requests must pass the guard. */
export function isGuardedRequest(method: string, path: string): boolean {
  return MUTATING_METHODS.has(method) && (path === '/api' || path.startsWith('/api/'));
}

/** Parse "host:port" authority; returns null unless hostname is loopback and port equals `port`. */
function loopbackAuthority(authority: string, port: number): string | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  if (!m) return null;
  const hostname = (m[1] ?? '').toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return null;
  if (Number(m[2]) !== port) return null;
  return `${hostname}:${m[2]}`;
}

/**
 * Validate a mutating request: loopback Host with the bound port, strict
 * `Content-Type: application/json` (even when bodyless), and Origin (if present)
 * equal to a loopback origin on the bound port. Returns null when allowed.
 */
export function checkMutatingRequest(req: http.IncomingMessage): GuardRejection | null {
  const port = req.socket.localPort ?? 0;
  const host = req.headers.host ?? '';
  if (loopbackAuthority(host, port) === null) {
    return { status: 403, message: 'Rejected: Host header must be a loopback address with the daemon port' };
  }
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { status: 415, message: 'Rejected: mutating requests require Content-Type: application/json' };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const m = /^http:\/\/(.+)$/.exec(origin);
    if (!m || loopbackAuthority(m[1] ?? '', port) === null) {
      return { status: 403, message: 'Rejected: Origin does not match the daemon origin' };
    }
  }
  return null;
}
