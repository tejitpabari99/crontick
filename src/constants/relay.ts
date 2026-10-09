/** Endpoint that mints a new smee.io channel via a 3xx redirect (`--relay auto`). */
export const SMEE_NEW_CHANNEL_URL = 'https://smee.io/new';

/** Timeout for the `--relay auto` channel-creation request. */
export const RELAY_CREATE_TIMEOUT_MS = 10_000;

/** Reconnect backoff: full jitter over min(MAX, BASE * 2^attempt). */
export const RELAY_BACKOFF_BASE_MS = 1_000;
export const RELAY_BACKOFF_MAX_MS = 60_000;

/** A connection that stayed up this long resets the backoff attempt counter. */
export const RELAY_STABLE_MS = 60_000;

/** No bytes from the relay for this long aborts and reconnects (smee pings ~30s). */
export const RELAY_IDLE_TIMEOUT_MS = 90_000;

/** Per-job burst limit on relay events: token bucket capacity, refilled evenly over RELAY_RATE_WINDOW_MS. */
export const RELAY_RATE_LIMIT_PER_WINDOW = 10;
export const RELAY_RATE_WINDOW_MS = 60_000;

/** Per-job delivery-id dedupe: LRU size and entry lifetime. */
export const RELAY_DEDUPE_MAX_ENTRIES = 256;
export const RELAY_DEDUPE_TTL_MS = 10 * 60_000;

/** `error` on the single skipped run recorded per rate-limit window; `{n}` is the dropped count. */
export const RELAY_RATE_LIMITED_ERROR = (n: number): string => `RATE_LIMITED (${n} dropped)`;
