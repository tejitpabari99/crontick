import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { VERSION } from '../version.js';
import { portFilePath, pidFilePath, dataDir, ensureDirs } from '../paths.js';
import { JobSchema } from '../schemas/job.js';
import { CrontickError } from '../errors.js';
import { createAutostart } from '../autostart/index.js';
import type { AutostartBackend } from '../autostart/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── API client ────────────────────────────────────────────────────────────────

function getPort(): number {
  const pf = portFilePath();
  if (!existsSync(pf)) {
    throw new CrontickError(
      'DAEMON_NOT_RUNNING',
      'Daemon is not running. Start it with: crontick daemon start',
    );
  }
  const port = parseInt(readFileSync(pf, 'utf-8').trim(), 10);
  if (isNaN(port)) {
    throw new CrontickError('DAEMON_NOT_RUNNING', 'Could not read daemon port file');
  }
  return port;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CrontickError('PARSE_ERROR', `Unexpected response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    throw new CrontickError(err?.code ?? 'API_ERROR', err?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function print(data: unknown, useJson: boolean): void {
  if (useJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('(no items)');
      return;
    }
    const rows = data as Array<Record<string, unknown>>;
    const keys = Object.keys(rows[0]);
    console.log(keys.join('\t'));
    for (const row of rows) {
      console.log(
        keys
          .map((k) => {
            const v = row[k];
            return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
          })
          .join('\t'),
      );
    }
  } else if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const display =
        value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      console.log(`${key}: ${display}`);
    }
  } else {
    console.log(String(data ?? ''));
  }
}

function handleError(err: unknown): never {
  if (err instanceof CrontickError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error(`Error: ${String(err)}`);
  }
  process.exit(1);
}

// ── Daemon helpers ────────────────────────────────────────────────────────────

function daemonScript(): string {
  // In dist: __dirname = dist/cli/, daemon is at dist/daemon/index.js
  // In source via ts-node/vitest: paths differ, but tests build first
  return resolve(__dirname, '../daemon/index.js');
}

function waitForPort(timeout = 10_000): Promise<number> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const port = getPort();
        resolve(port);
      } catch {
        if (Date.now() - start > timeout) {
          reject(new CrontickError('DAEMON_TIMEOUT', 'Timed out waiting for daemon to start'));
        } else {
          setTimeout(check, 200);
        }
      }
    };
    check();
  });
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('crontick')
  .description('A standalone cron daemon, CLI, and MCP server for local scheduled jobs.')
  .version(VERSION)
  .option('--json', 'Output as JSON');

// ── new ───────────────────────────────────────────────────────────────────────

program
  .command('new <id>')
  .description('Create a new job')
  .option('--cron <expr>', 'Cron expression (e.g. "0 9 * * *")')
  .option('--every <sec>', 'Interval in seconds', parseInt)
  .option('--at <iso>', 'One-shot run-at ISO-8601 time')
  .option('--tz <tz>', 'Timezone for cron schedule')
  .option('--script <body>', 'Inline script body')
  .option('--exec <cmd>', 'Command to exec (use -- for args)')
  .option('--file <path>', 'Load full job from JSON file')
  .option('--shell <shell>', 'Shell: auto|bash|pwsh|cmd', 'auto')
  .option('--env-file <path>', 'Load extra environment variables from a .env file')
  .option('--timeout <sec>', 'Timeout in seconds', parseInt)
  .option('--overlap <policy>', 'Overlap policy: skip|queue|cancel-previous', 'skip')
  .option('--retry <max>', 'Retry count', parseInt)
  .option('--desc <description>', 'Job description')
  .action(async (id: string, opts) => {
    try {
      let jobData: unknown;

      if (opts.file) {
        const raw = readFileSync(resolve(process.cwd(), opts.file as string), 'utf-8');
        jobData = JSON.parse(raw);
      } else {
        // Build schedule
        let schedule: unknown;
        if (opts.cron) {
          schedule = { kind: 'cron', cron: opts.cron as string, tz: opts.tz as string | undefined };
        } else if (opts.every) {
          schedule = { kind: 'interval', everySec: opts.every as number };
        } else if (opts.at) {
          schedule = { kind: 'one-shot', runAt: opts.at as string };
        } else {
          throw new CrontickError('MISSING_ARG', 'Provide --cron, --every <sec>, or --at <iso>');
        }

        // Build action
        let action: unknown;
        if (opts.script) {
          action = {
            kind: 'script',
            script: opts.script as string,
            shell: opts.shell as string,
            envFile: opts.envFile as string | undefined,
            timeoutSec: opts.timeout as number | undefined,
          };
        } else if (opts.exec) {
          const parts = (opts.exec as string).split(/\s+/);
          action = {
            kind: 'exec',
            command: parts[0],
            args: parts.slice(1),
            envFile: opts.envFile as string | undefined,
            timeoutSec: opts.timeout as number | undefined,
          };
        } else {
          throw new CrontickError('MISSING_ARG', 'Provide --script or --exec');
        }

        jobData = {
          id,
          description: opts.desc as string | undefined,
          schedule,
          action,
          overlap: opts.overlap as string,
          retry: opts.retry !== undefined ? { max: opts.retry as number, backoffSec: 30 } : undefined,
        };
      }

      const parsed = JobSchema.safeParse(jobData);
      if (!parsed.success) {
        throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
      }

      const result = await api('POST', '/api/jobs', parsed.data);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all jobs')
  .action(async () => {
    try {
      const jobs = await api('GET', '/api/jobs');
      print(jobs, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── get ───────────────────────────────────────────────────────────────────────

program
  .command('get <id>')
  .description('Get a job by ID')
  .action(async (id: string) => {
    try {
      const job = await api('GET', `/api/jobs/${encodeURIComponent(id)}`);
      print(job, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── enable / disable / delete ─────────────────────────────────────────────────

program
  .command('enable <id>')
  .description('Enable a job')
  .action(async (id: string) => {
    try {
      const result = await api('POST', `/api/jobs/${encodeURIComponent(id)}/enable`);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('disable <id>')
  .description('Disable a job')
  .action(async (id: string) => {
    try {
      const result = await api('POST', `/api/jobs/${encodeURIComponent(id)}/disable`);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('delete <id>')
  .description('Delete a job')
  .action(async (id: string) => {
    try {
      const result = await api('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── run-now ───────────────────────────────────────────────────────────────────

program
  .command('run-now <id>')
  .description('Trigger an immediate run of a job')
  .action(async (id: string) => {
    try {
      const result = await api('POST', `/api/jobs/${encodeURIComponent(id)}/run`);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── logs ──────────────────────────────────────────────────────────────────────

program
  .command('logs <runId>')
  .description('Get logs for a run')
  .option('--follow', 'Follow (SSE stream) — not implemented in CLI yet; use --tail')
  .option('--tail <n>', 'Show last N lines', parseInt)
  .action(async (runId: string, opts) => {
    try {
      const useJson = !!(program.opts() as { json?: boolean }).json;
      const logs = await api('GET', `/api/runs/${encodeURIComponent(runId)}/logs`) as Array<{
        stream: string;
        ts: number;
        data: string;
      }>;
      const lines = (Array.isArray(logs) ? logs : []) as Array<{ stream: string; ts: number; data: string }>;
      const tail = opts.tail as number | undefined;
      const display = tail ? lines.slice(-tail) : lines;
      if (useJson) {
        console.log(JSON.stringify(display, null, 2));
      } else {
        for (const entry of display) {
          process.stdout.write(`[${entry.stream}] ${entry.data}`);
        }
      }
    } catch (err) {
      handleError(err);
    }
  });

// ── export / import ───────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export all jobs')
  .option('--out <file>', 'Output file (default: stdout)')
  .action(async (opts) => {
    try {
      const data = await api('GET', '/api/export');
      const json = JSON.stringify(data, null, 2);
      if (opts.out) {
        writeFileSync(resolve(process.cwd(), opts.out as string), json, 'utf-8');
        console.log(`Exported to ${opts.out as string}`);
      } else {
        console.log(json);
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('import <file>')
  .description('Import jobs from a JSON file')
  .action(async (file: string) => {
    try {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf-8');
      const data = JSON.parse(raw);
      const result = await api('POST', '/api/import', data);
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check system health')
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; note?: string }> = [];

    // Node version
    const major = parseInt(process.versions.node.split('.')[0], 10);
    checks.push({
      name: 'Node.js >= 22.5',
      ok: major >= 22,
      note: `v${process.versions.node}`,
    });

    // SQLite availability
    try {
      const { DatabaseSync } = await import('node:sqlite');
      new DatabaseSync(':memory:').close();
      checks.push({ name: 'node:sqlite', ok: true });
    } catch (err) {
      checks.push({ name: 'node:sqlite', ok: false, note: String(err) });
    }

    // Data dir
    try {
      ensureDirs();
      checks.push({ name: 'data dir writable', ok: true });
    } catch (err) {
      checks.push({ name: 'data dir writable', ok: false, note: String(err) });
    }

    // Port file
    const portFile = portFilePath();
    const portFileExists = existsSync(portFile);
    checks.push({ name: 'port file readable', ok: portFileExists, note: portFileExists ? portFile : 'not found' });

    // Daemon reachable
    try {
      await api('GET', '/health');
      checks.push({ name: 'daemon reachable', ok: true });
    } catch {
      checks.push({ name: 'daemon reachable', ok: false, note: 'not running' });
    }

    // Dashboard reachable
    try {
      const port2 = getPort();
      const dashRes = await fetch(`http://127.0.0.1:${port2}/dashboard`, {
        signal: AbortSignal.timeout(2000),
      });
      const text = await dashRes.text();
      checks.push({
        name: 'dashboard reachable',
        ok: dashRes.status === 200 && text.includes('crontick'),
        note: dashRes.status === 200 ? 'ok' : `HTTP ${dashRes.status}`,
      });
    } catch {
      checks.push({ name: 'dashboard reachable', ok: false, note: 'daemon not running or no dashboard' });
    }

    // Autostart status
    try {
      const asResult = await api('GET', '/api/autostart/status');
      const as = asResult as { installed?: boolean; backend?: string };
      checks.push({
        name: 'autostart',
        ok: true,
        note: `backend=${as.backend ?? '?'}, installed=${String(as.installed ?? false)}`,
      });
    } catch {
      checks.push({ name: 'autostart', ok: false, note: 'could not check (daemon not running)' });
    }

    // MCP server binary
    const mcpScript = resolve(__dirname, '../mcp/index.js');
    checks.push({
      name: 'MCP server binary',
      ok: existsSync(mcpScript),
      note: mcpScript,
    });

    // MCP server --help smoke test
    try {
      const result = spawnSync(process.execPath, [mcpScript, '--help'], {
        timeout: 5000,
        encoding: 'utf-8',
        env: { ...process.env, CRONTICK_MCP_NO_AUTOSTART: '1' },
      });
      // --help exits 0 on commander; if exit code is 0 or it printed help text it's fine
      const helpOk = result.status === 0 || (result.stdout ?? '').includes('stdio');
      checks.push({ name: 'MCP server --help', ok: helpOk });
    } catch (err) {
      checks.push({ name: 'MCP server --help', ok: false, note: String(err) });
    }

    for (const c of checks) {
      const icon = c.ok ? '✓' : '✗';
      console.log(`${icon} ${c.name}${c.note ? ` (${c.note})` : ''}`);
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) process.exit(1);
  });

// ── daemon ────────────────────────────────────────────────────────────────────

const daemon = program.command('daemon').description('Manage the crontick daemon');

daemon
  .command('start')
  .description('Start the daemon (detached by default)')
  .option('--foreground', 'Run in foreground (blocking)')
  .action(async (opts) => {
    try {
      const script = daemonScript();
      if (!existsSync(script)) {
        throw new CrontickError('NOT_BUILT', `Daemon script not found: ${script}. Run: npm run build`);
      }

      if (opts.foreground as boolean) {
        // Run inline (blocking — for testing/debugging)
        const result = spawnSync(process.execPath, [script], {
          stdio: 'inherit',
          env: process.env,
        });
        process.exit(result.status ?? 0);
      } else {
        const child = spawn(process.execPath, [script], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
        console.log(`Starting daemon (pid will be written to port file)…`);
        const port = await waitForPort();
        console.log(`Daemon started on port ${port}`);
      }
    } catch (err) {
      handleError(err);
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    try {
      const pidFile = pidFilePath();
      if (!existsSync(pidFile)) {
        console.log('Daemon is not running');
        return;
      }
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to daemon (pid ${pid})`);
    } catch (err) {
      handleError(err);
    }
  });

daemon
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    try {
      const status = await api('GET', '/api/daemon/status');
      print(status, !!(program.opts() as { json?: boolean }).json);
    } catch {
      console.log('Daemon is not running');
    }
  });

daemon
  .command('reload')
  .description('Reload jobs from disk')
  .action(async () => {
    try {
      const result = await api('POST', '/api/daemon/reload');
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

daemon
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    try {
      // Stop if running
      const pidFile = pidFilePath();
      if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 1000));
        } catch {
          // ignore
        }
      }

      // Start
      const script = daemonScript();
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      const port = await waitForPort();
      console.log(`Daemon restarted on port ${port}`);
    } catch (err) {
      handleError(err);
    }
  });

// ── autostart ─────────────────────────────────────────────────────────────────

const autostart = program.command('autostart').description('Manage daemon autostart at login');

autostart
  .command('install')
  .description('Register the daemon to start automatically at login')
  .option('--backend <backend>', 'Backend: win32|darwin|linux|manual (default: auto-detect)')
  .action(async (opts) => {
    try {
      const backend = opts.backend as AutostartBackend | undefined;
      const as = createAutostart({ backend });
      const result = await as.install();
      print(result, !!(program.opts() as { json?: boolean }).json);
      if (process.platform !== 'win32' && !backend) {
        const statusResult = await as.status();
        const details = (statusResult.details as Record<string, unknown> | undefined);
        const instr = details?.['instructions'] as string | undefined;
        if (instr) console.log('\nManual setup instructions:\n' + instr);
      }
    } catch (err) {
      handleError(err);
    }
  });

autostart
  .command('remove')
  .description('Remove the daemon from automatic startup')
  .option('--backend <backend>', 'Backend: win32|darwin|linux|manual (default: auto-detect)')
  .action(async (opts) => {
    try {
      const backend = opts.backend as AutostartBackend | undefined;
      const as = createAutostart({ backend });
      const result = await as.remove();
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

autostart
  .command('status')
  .description('Check whether the daemon is registered for automatic startup')
  .option('--backend <backend>', 'Backend: win32|darwin|linux|manual (default: auto-detect)')
  .action(async (opts) => {
    try {
      const backend = opts.backend as AutostartBackend | undefined;
      const as = createAutostart({ backend });
      const result = await as.status();
      print(result, !!(program.opts() as { json?: boolean }).json);
    } catch (err) {
      handleError(err);
    }
  });

// ── uninstall ─────────────────────────────────────────────────────────────────

program
  .command('uninstall')
  .description('Remove autostart entry and optionally delete all crontick data')
  .option('--purge', 'Also delete the data directory (jobs, runs, config)')
  .option('--yes', 'Skip confirmation prompts')
  .action(async (opts) => {
    try {
      // Remove autostart
      const as = createAutostart();
      await as.remove();
      console.log('✓ Autostart entry removed.');

      if (opts.purge as boolean) {
        const dir = dataDir();
        let confirmed = opts.yes as boolean;
        if (!confirmed) {
          confirmed = await new Promise<boolean>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Delete all crontick data at ${dir}? [y/N] `, (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase() === 'y');
            });
          });
        }
        if (confirmed) {
          rmSync(dir, { recursive: true, force: true });
          console.log(`✓ Data directory deleted: ${dir}`);
        } else {
          console.log('Skipped data directory deletion.');
        }
      } else {
        console.log(
          'Data directory preserved. Run `crontick uninstall --purge` to also delete it.',
        );
      }
    } catch (err) {
      handleError(err);
    }
  });

// ── dashboard ─────────────────────────────────────────────────────────────────

program
  .command('dashboard')
  .description('Open the crontick dashboard in a browser')
  .option('--open', 'Open in the default browser')
  .action(async (opts) => {
    try {
      const port = getPort();
      const url = `http://127.0.0.1:${port}/dashboard`;
      if (opts.open as boolean) {
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          try {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
          } catch {
            // xdg-open not available
          }
        }
        console.log(`Dashboard opened: ${url}`);
      } else {
        console.log(`Dashboard: ${url}`);
      }
    } catch (err) {
      handleError(err);
    }
  });

// ── mcp ───────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Start the crontick MCP server on stdio (for use with Claude Desktop, Copilot, Cursor, etc.)')
  .option('--no-autostart', 'Do not auto-start the daemon if it is not already running')
  .option('--daemon-url <url>', 'Override the daemon URL (default: resolved from port file)')
  .addHelpText(
    'after',
    `
Transport:    stdio (JSON-RPC 2.0 over stdin/stdout)
Tool prefix:  crontick_
Autostart:    Daemon is auto-started unless --no-autostart or CRONTICK_MCP_NO_AUTOSTART=1 is set

Example MCP host config (Claude Desktop):
  {
    "mcpServers": {
      "crontick": { "command": "crontick", "args": ["mcp"] }
    }
  }`,
  )
  .action((opts) => {
    const mcpScript = resolve(__dirname, '../mcp/index.js');
    if (!existsSync(mcpScript)) {
      console.error(`MCP server script not found: ${mcpScript}. Run: npm run build`);
      process.exit(1);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.noAutostart) env['CRONTICK_MCP_NO_AUTOSTART'] = '1';
    if (opts.daemonUrl) env['CRONTICK_DAEMON_URL'] = opts.daemonUrl as string;
    const result = spawnSync(process.execPath, [mcpScript], {
      stdio: 'inherit',
      env,
    });
    process.exit(result.status ?? 0);
  });

// ── parse ─────────────────────────────────────────────────────────────────────

program.parse();
