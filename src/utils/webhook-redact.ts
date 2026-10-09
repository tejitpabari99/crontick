/**
 * Redaction for webhook schedule secrets. The relay URL is a bearer secret and `secret` is an HMAC key.
 * Display form: relay `https://smee.io/Uk…Sd` (first/last 2 chars of the channel), secret `set`.
 * Kept separate from `redactValue` (logger core is unchanged).
 */
const ELLIPSIS = '…';
const SMEE_URL_RE = /https?:\/\/smee\.io\/[^\s"'<>)]+/g;

/** Masks the last path segment (the channel id) of a relay URL; idempotent. */
export function redactRelayUrl(url: string): string {
  const idx = url.lastIndexOf('/');
  if (idx < 0) return ELLIPSIS;
  const head = url.slice(0, idx + 1);
  const seg = url.slice(idx + 1);
  if (seg.includes(ELLIPSIS)) return url;
  if (seg.length <= 6) return `${head}${ELLIPSIS}`;
  return `${head}${seg.slice(0, 2)}${ELLIPSIS}${seg.slice(-2)}`;
}

/** Redacts smee.io channel URLs inside free text (notices, messages). */
export function redactSmeeUrlsInText(text: string): string {
  return text.replace(SMEE_URL_RE, (m) => redactRelayUrl(m));
}

function isWebhookSchedule(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { kind?: unknown }).kind === 'webhook';
}

/** Deep copy where every `{kind:'webhook'}` object has `relay` masked and `secret` replaced by `set`. */
export function redactWebhookDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWebhookDeep);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactWebhookDeep(v);
  if (isWebhookSchedule(out)) {
    if (typeof out['relay'] === 'string') out['relay'] = redactRelayUrl(out['relay']);
    if (out['secret'] !== undefined && out['secret'] !== null) out['secret'] = 'set';
  }
  return out;
}

/**
 * Keeps stored webhook relay/secret when an incoming schedule carries the display form
 * (a list payload round-tripped through an editor). Returns the schedule to persist.
 */
export function restoreRedactedWebhook<S>(incoming: S, stored: unknown): S {
  if (!isWebhookSchedule(incoming) || !isWebhookSchedule(stored)) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  if (typeof out['relay'] === 'string' && typeof stored['relay'] === 'string' && out['relay'] === redactRelayUrl(stored['relay'])) out['relay'] = stored['relay'];
  if (out['secret'] === 'set' && typeof stored['secret'] === 'string') out['secret'] = stored['secret'];
  return out as S;
}
