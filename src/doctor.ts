/**
 * System health checks. Verifies Node version, node:sqlite availability,
 * data dir writability, daemon reachability, dashboard assets, and MCP binary.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dataDir, ensureDirs, portFilePath } from './paths.js';
import { configFilePath, loadConfig } from './config.js';
import type { CrontickConfig } from './schemas/config.js';
import net from 'node:net';
import { probeHealth, readPortFile, resolveDaemonBaseUrl } from './daemon/ensure.js';
import type { RelayStatusView } from './utils/webhook-redact.js';
import { describeDaemonPort, preferredDaemonPort } from './daemon/bind-port.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  note?: string;
  /** Advisory only: the check passes (`ok`) but should be flagged (printed as WARN). */
  warn?: boolean;
}

export interface DoctorOptions {
  daemonUrl?: string;
  mcpScript?: string;
  env?: NodeJS.ProcessEnv;
  checkMcpHelp?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctorChecks(options: DoctorOptions = {}): Promise<DoctorResult> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const checks: DoctorCheck[] = [];

  const [major, minor] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
  checks.push({
    name: 'Node.js >= 22.5',
    ok: major > 22 || (major === 22 && minor >= 5),
    note: `v${process.versions.node}`,
  });

  try {
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync(':memory:').close();
    checks.push({ name: 'node:sqlite', ok: true });
  } catch (err) {
    checks.push({ name: 'node:sqlite', ok: false, note: String(err) });
  }

  try {
    ensureDirs(env);
    checks.push({ name: 'data dir writable', ok: true, note: dataDir(env) });
  } catch (err) {
    checks.push({ name: 'data dir writable', ok: false, note: String(err) });
  }

  // The config file is optional and only created on demand; report truthfully
  // whether it exists so users looking for the printed path are not misled.
  const cfgPath = configFilePath({ env });
  checks.push({
    name: 'config file',
    ok: true,
    note: existsSync(cfgPath) ? cfgPath : `${cfgPath} - not created yet, built-in defaults in use`,
  });

  const portPath = portFilePath(env);
  const portFileExists = existsSync(portPath);
  checks.push({ name: 'port file readable', ok: portFileExists, note: portFileExists ? portPath : 'not found' });

  let baseUrl: string | undefined;
  let daemonReachable = false;
  try {
    baseUrl = await resolveDaemonBaseUrl({ daemonUrl: options.daemonUrl, env });
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    daemonReachable = res.ok;
    checks.push({ name: 'daemon reachable', ok: res.ok, note: res.ok ? 'ok' : `HTTP ${res.status}` });
  } catch {
    checks.push({ name: 'daemon reachable', ok: false, note: 'not running' });
  }

  checks.push(await daemonPortCheck(env, portFileExists, daemonReachable));

  if (baseUrl) {
    try {
      const dashRes = await fetch(`${baseUrl}/dashboard`, { signal: AbortSignal.timeout(2_000) });
      const text = await dashRes.text();
      checks.push({
        name: 'dashboard reachable',
        ok: dashRes.status === 200 && text.includes('crontick'),
        note: dashRes.status === 200 ? 'ok' : `HTTP ${dashRes.status}`,
      });
    } catch {
      checks.push({ name: 'dashboard reachable', ok: false, note: 'daemon not running or no dashboard' });
    }
  } else {
    checks.push({ name: 'dashboard reachable', ok: false, note: 'daemon not running or no dashboard' });
  }

  if (daemonReachable && baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/api/relays`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) checks.push(...relayDoctorChecks((await res.json()) as RelayStatusView[]));
    } catch {
      // Relay status is advisory; an unreachable endpoint adds no check.
    }
  }

  if (options.mcpScript) {
    checks.push({ name: 'MCP server binary', ok: existsSync(options.mcpScript), note: options.mcpScript });
    if (options.checkMcpHelp ?? true) {
      try {
        const result = spawnSync(process.execPath, [options.mcpScript, '--help'], {
          timeout: 5_000,
          encoding: 'utf-8',
          env: { ...env, CRONTICK_MCP_START_DAEMON: '0' },
        });
        const helpOk = result.status === 0 || (result.stdout ?? '').includes('stdio');
        checks.push({ name: 'MCP server --help', ok: helpOk });
      } catch (err) {
        checks.push({ name: 'MCP server --help', ok: false, note: String(err) });
      }
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

/** "daemon port" check: config vs running port, and a foreign listener on the target port when no daemon runs. */
async function daemonPortCheck(env: NodeJS.ProcessEnv, portFileExists: boolean, daemonReachable: boolean): Promise<DoctorCheck> {
  let config: Pick<CrontickConfig, 'daemon'> = { daemon: {} };
  try {
    config = loadConfig({ env });
  } catch {
    // Malformed config is reported elsewhere; fall back to defaults here.
  }
  const pref = preferredDaemonPort(config);
  const preferred = pref.port;
  const port = readPortFile(env);
  if (port !== undefined) {
    const note = describeDaemonPort(port, config);
    if (pref.explicit) return { name: 'daemon port', ok: true, note: `${port} (from config${note ? `; ${note}` : ''})` };
    return { name: 'daemon port', ok: true, note: note ? `${port} (${note})` : preferred === 0 ? String(port) : `${port} (default)` };
  }
  if (!portFileExists && !daemonReachable && preferred > 0) {
    // No daemon: is something else squatting on the target port?
    const probe = await probeHealth(`http://127.0.0.1:${preferred}`, 1_000);
    const held = !probe.ok && (await isPortListening(preferred));
    if (pref.explicit) {
      return held
        ? { name: 'daemon port', ok: false, note: `${preferred} (from config) is held by another process; the daemon will fail to start` }
        : { name: 'daemon port', ok: true, note: `${preferred} (from config); no daemon running, port is free` };
    }
    if (held) {
      return { name: 'daemon port', ok: true, note: `default ${preferred} is held by another process; the daemon will start on a free port` };
    }
    return { name: 'daemon port', ok: true, note: `no daemon running; default ${preferred} is free` };
  }
  return { name: 'daemon port', ok: true, note: 'unknown (port file unreadable)' };
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (result: boolean): void => { socket.destroy(); resolve(result); };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** One `relay:` check per relay; a relay in `error`, or retrying after an error, is a WARN (never fails doctor). */
export function relayDoctorChecks(statuses: readonly RelayStatusView[]): DoctorCheck[] {
  return statuses.map((s) => {
    const failing = s.state === 'error' || (s.state === 'backoff' && s.lastError !== null);
    const base = `${s.state}, ${s.eventCount} event(s)${s.lastEventAt ? `, last ${s.lastEventAt}` : ''}`;
    return failing
      ? { name: `relay: ${s.urlRedacted}`, ok: true, warn: true, note: `${base}; ${s.lastError ?? 'error'}` }
      : { name: `relay: ${s.urlRedacted}`, ok: true, note: base };
  });
}
