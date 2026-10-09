import { posix } from 'node:path';
import { dataDir } from '../paths.js';
import type { AutostartSpec } from './types.js';

/** Pure, dependency-free renderer/parser for the launchd LaunchAgent plist. */

export const PLIST_LABEL = 'dev.crontick.daemon';

export interface PlistPaths {
  logsDir: string;
  dataDir: string;
}

/** Derives log/data dirs from the spec's `CRONTICK_HOME` (or the platform default when unset). */
export function plistPaths(spec: AutostartSpec): PlistPaths {
  const data = dataDir(spec.env);
  // launchd only exists on macOS: always POSIX-join, even when running on a Windows host.
  return { logsDir: posix.join(data, 'logs'), dataDir: data };
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unesc(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g, (_m, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function str(v: string): string {
  // XML 1.0 cannot represent most control characters; refuse rather than emit an invalid plist.
  if ([...v].some((c) => { const n = c.charCodeAt(0); return n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d; })) {
    throw new Error('Cannot write a value containing control characters into a launchd plist.');
  }
  return `<string>${esc(v)}</string>`;
}

/** Renders the LaunchAgent plist for `spec`. Emits exactly the documented keys, nothing else. */
export function renderPlist(spec: AutostartSpec, label: string, paths: PlistPaths): string {
  const env = Object.entries(spec.env).map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t${str(v)}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${str(label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    `\t\t${str(spec.nodePath)}`,
    `\t\t${str(spec.daemonScript)}`,
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    env.length > 0 ? ['\t<dict>', ...env, '\t</dict>'].join('\n') : '\t<dict/>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    '\t<key>ThrottleInterval</key>',
    '\t<integer>30</integer>',
    '\t<key>AbandonProcessGroup</key>',
    '\t<true/>',
    '\t<key>StandardOutPath</key>',
    `\t${str(posix.join(paths.logsDir, 'launchd.out.log'))}`,
    '\t<key>StandardErrorPath</key>',
    `\t${str(posix.join(paths.logsDir, 'launchd.err.log'))}`,
    '\t<key>WorkingDirectory</key>',
    `\t${str(paths.dataDir)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

type PlistValue = string | boolean | number | PlistValue[] | { [k: string]: PlistValue };

/** Minimal tolerant plist value parser (dict/array/string/true/false/integer/real). */
function parseValue(xml: string, pos: { i: number }): PlistValue | undefined {
  const tag = /^\s*<(\/?)([A-Za-z]+)\s*(\/?)>/.exec(xml.slice(pos.i));
  if (!tag || tag[1]) return undefined;
  const name = tag[2]!;
  pos.i += tag[0].length;
  const selfClosed = tag[3] === '/';
  if (name === 'true' || name === 'false') return name === 'true';
  if (name === 'string' || name === 'integer' || name === 'real' || name === 'key') {
    if (selfClosed) return name === 'string' ? '' : undefined;
    const end = xml.indexOf(`</${name}>`, pos.i);
    if (end < 0) return undefined;
    const text = unesc(xml.slice(pos.i, end));
    pos.i = end + name.length + 3;
    return name === 'integer' || name === 'real' ? Number(text) : text;
  }
  if (name === 'array') {
    const out: PlistValue[] = [];
    if (selfClosed) return out;
    for (;;) {
      const close = /^\s*<\/array>/.exec(xml.slice(pos.i));
      if (close) {
        pos.i += close[0].length;
        return out;
      }
      const v = parseValue(xml, pos);
      if (v === undefined) return undefined;
      out.push(v);
    }
  }
  if (name === 'dict') {
    const out: { [k: string]: PlistValue } = {};
    if (selfClosed) return out;
    for (;;) {
      const close = /^\s*<\/dict>/.exec(xml.slice(pos.i));
      if (close) {
        pos.i += close[0].length;
        return out;
      }
      const k = /^\s*<key>([\s\S]*?)<\/key>/.exec(xml.slice(pos.i));
      if (!k) return undefined;
      pos.i += k[0].length;
      const v = parseValue(xml, pos);
      if (v === undefined) return undefined;
      out[unesc(k[1]!)] = v;
    }
  }
  return undefined;
}

/** Parses a plist back to its command and env; `undefined` when unparseable or no ProgramArguments. */
export function parsePlist(xml: string): { nodePath: string; args: string[]; env: Record<string, string> } | undefined {
  try {
    const start = xml.indexOf('<dict');
    if (start < 0) return undefined;
    const root = parseValue(xml, { i: start });
    if (!root || typeof root !== 'object' || Array.isArray(root)) return undefined;
    const argv = root['ProgramArguments'];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) return undefined;
    const env: Record<string, string> = {};
    const rawEnv = root['EnvironmentVariables'];
    if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
      for (const [k, v] of Object.entries(rawEnv)) if (typeof v === 'string') env[k] = v;
    }
    return { nodePath: argv[0] as string, args: (argv as string[]).slice(1), env };
  } catch {
    return undefined;
  }
}
