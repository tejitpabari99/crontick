import { RELAY_CREATE_TIMEOUT_MS, SMEE_NEW_CHANNEL_URL } from '../constants/relay.js';
import { CrontickError } from '../errors.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]', '::1']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** True for an https URL, or an http URL whose host is loopback (tests / self-hosted relays). */
export function isValidRelayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/**
 * Creates a smee.io channel: GETs `smee.io/new` WITHOUT following redirects and returns the `Location`.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function createRelayChannel(fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(SMEE_NEW_CHANNEL_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(RELAY_CREATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CrontickError('RELAY_CREATE_FAILED', `Could not create a relay channel at ${SMEE_NEW_CHANNEL_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new CrontickError('RELAY_CREATE_FAILED', `Relay channel creation failed: expected a redirect from ${SMEE_NEW_CHANNEL_URL}, got HTTP ${res.status}`);
  }
  const channel = new URL(location, SMEE_NEW_CHANNEL_URL).toString();
  if (!isValidRelayUrl(channel)) {
    throw new CrontickError('RELAY_CREATE_FAILED', 'Relay channel creation returned an invalid redirect target');
  }
  return channel;
}
