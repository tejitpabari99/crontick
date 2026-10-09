// THROWAWAY gate (SP09 Task 1): does the detached daemon survive the Task
// Scheduler launcher instance ending? Windows-only; skipped elsewhere.
// Requires a prior `npm run build`. Hardened into the real test in Task 6.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const isWin = process.platform === 'win32';
const log = (...a: unknown[]): void => { console.log('[gate]', ...a); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function schtasks(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  log(`schtasks ${args.join(' ')} -> exit ${String(r.status)}\n${out}`);
  return { status: r.status, out };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(!isWin)('windows launcher survival', () => {
  it('daemon outlives the schtasks launcher instance', async () => {
    const cli = resolve('dist', 'cli', 'index.js');
    expect(existsSync(cli)).toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'crontick-gate-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { port: 0 } }));
    const name = `\\crontick-gate-${Math.random().toString(36).slice(2, 10)}`;
    const user = `${process.env['USERDOMAIN'] ?? ''}\\${process.env['USERNAME'] ?? ''}`;
    const xmlPath = join(home, 'task.xml');
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>crontick-gate</Author></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(user)}</UserId><Delay>PT30S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>false</StartWhenAvailable><Hidden>false</Hidden><Enabled>true</Enabled>
    <AllowStartOnDemand>true</AllowStartOnDemand></Settings>
  <Actions Context="Author"><Exec><Command>${esc(process.execPath)}</Command><Arguments>${esc(`"${cli}" daemon start --home "${home}"`)}</Arguments></Exec></Actions>
</Task>`;
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    log('node', process.execPath, 'cli', cli, 'home', home, 'user', user);

    let daemonPid: number | undefined;
    try {
      expect(schtasks(['/Create', '/TN', name, '/XML', xmlPath, '/F']).status).toBe(0);
      expect(schtasks(['/Run', '/TN', name]).status).toBe(0);

      // Wait for the launcher instance to finish (status no longer Running).
      let state = '';
      const deadline = Date.now() + 90_000;
      let sawNotRunning = false;
      while (Date.now() < deadline) {
        await sleep(1000);
        const q = schtasks(['/Query', '/TN', name, '/V', '/FO', 'LIST']);
        state = /^Status:\s*(.+)$/m.exec(q.out)?.[1]?.trim() ?? '?';
        if (state !== 'Running' && existsSync(join(home, 'daemon.pid'))) { sawNotRunning = true; break; }
      }
      log('final task state', state, 'launcher finished', sawNotRunning);
      expect(sawNotRunning).toBe(true);

      // Give Task Scheduler time to reap anything it intends to kill.
      await sleep(10_000);
      const q2 = schtasks(['/Query', '/TN', name, '/V', '/FO', 'LIST']);
      log('post-wait state', q2.out.match(/^(Status|Last Run Result):.*$/gm));

      daemonPid = Number(readFileSync(join(home, 'daemon.pid'), 'utf8').trim().split(/\s+/)[0]);
      const port = Number(readFileSync(join(home, 'daemon.port'), 'utf8').trim());
      log('daemon pid', daemonPid, 'port', port);
      expect(alive(daemonPid)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      const body = await res.text();
      log('health', res.status, body.slice(0, 300));
      expect(res.status).toBe(200);
      log('SURVIVAL PASS');
    } finally {
      try {
        spawnSync(process.execPath, [cli, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: home }, encoding: 'utf8', stdio: 'inherit' });
        if (daemonPid !== undefined && alive(daemonPid)) execFileSync('taskkill', ['/PID', String(daemonPid), '/T', '/F'], { stdio: 'inherit' });
      } catch (e) { log('stop error', e); }
      schtasks(['/Delete', '/TN', name, '/F']);
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 180_000);
});
