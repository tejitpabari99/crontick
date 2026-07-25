import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ensureDirs, portFilePath } from './paths.js';
import { resolveDaemonBaseUrl } from './daemon/ensure.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  note?: string;
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
    checks.push({ name: 'data dir writable', ok: true });
  } catch (err) {
    checks.push({ name: 'data dir writable', ok: false, note: String(err) });
  }

  const portPath = portFilePath(env);
  const portFileExists = existsSync(portPath);
  checks.push({ name: 'port file readable', ok: portFileExists, note: portFileExists ? portPath : 'not found' });

  let baseUrl: string | undefined;
  try {
    baseUrl = await resolveDaemonBaseUrl({ daemonUrl: options.daemonUrl, env });
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    checks.push({ name: 'daemon reachable', ok: res.ok, note: res.ok ? 'ok' : `HTTP ${res.status}` });
  } catch {
    checks.push({ name: 'daemon reachable', ok: false, note: 'not running' });
  }

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
