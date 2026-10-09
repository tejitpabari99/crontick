import type { AutostartSpec } from './types.js';

/** Pure renderer/parser for the systemd user unit. */

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
}

function quote(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('Cannot write a value containing a newline into a systemd unit.');
  return `"${esc(v)}"`;
}

/** Renders the unit text for `spec` (direct node + daemon script, supervised env). */
export function renderUnit(spec: AutostartSpec): string {
  const envLines = Object.entries(spec.env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  return [
    '[Unit]',
    'Description=crontick daemon',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quote(spec.nodePath)} ${quote(spec.daemonScript)}`,
    ...envLines,
    'Restart=on-failure',
    'RestartSec=5',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Splits a systemd command/assignment line into words, undoing quoting, `\` escapes, `%%` and `$$`. */
function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quoteCh: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length) {
      const n = line[++i]!;
      cur += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      inWord = true;
    } else if (quoteCh) {
      if (c === quoteCh) quoteCh = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quoteCh = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words.map((w) => w.replace(/%%/g, '%').replace(/\$\$/g, '$'));
}

/** Parses a unit back to its command and env; `undefined` when there is no ExecStart. */
export function parseUnit(text: string): { nodePath: string; args: string[]; env: Record<string, string> } | undefined {
  let argv: string[] | undefined;
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('ExecStart=')) {
      argv = splitWords(line.slice('ExecStart='.length));
    } else if (line.startsWith('Environment=')) {
      for (const w of splitWords(line.slice('Environment='.length))) {
        const eq = w.indexOf('=');
        if (eq > 0) env[w.slice(0, eq)] = w.slice(eq + 1);
      }
    }
  }
  if (!argv || argv.length === 0) return undefined;
  return { nodePath: argv[0]!, args: argv.slice(1), env };
}
