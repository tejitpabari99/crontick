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
