import type { AutostartSpec } from './types.js';

/** Pure renderer/parser for the Windows Task Scheduler task definition (XML). */

export const TASK_NAME = '\\crontick\\daemon';

const DESCRIPTION =
  'Starts the crontick scheduler daemon at logon. Created by `crontick autostart enable`; remove with `crontick autostart disable`.';

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

/** Escapes a value; refuses characters XML 1.0 cannot represent. */
function val(v: string): string {
  if ([...v].some((c) => { const n = c.charCodeAt(0); return n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d; })) {
    throw new Error('Cannot write a value containing control characters into a Task Scheduler definition.');
  }
  return esc(v);
}

/** Arguments string for the launcher action: `"<cli>" daemon start [--home "<dir>"]`. */
function renderArguments(spec: AutostartSpec): string {
  const home = spec.env['CRONTICK_HOME'];
  const parts = [`"${spec.cliScript}"`, 'daemon', 'start'];
  if (home) parts.push('--home', `"${home}"`);
  return parts.join(' ');
}

/**
 * Renders the logon-task definition for `spec`, scoped to `sid`. Emits exactly the documented
 * settings, nothing else. The caller must write it as UTF-16LE (see `encodeTaskXml`).
 */
export function renderTaskXml(spec: AutostartSpec, sid: string): string {
  const user = val(sid);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>crontick</Author>',
    `    <URI>${val(TASK_NAME)}</URI>`,
    `    <Description>${val(DESCRIPTION)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '      <Delay>PT30S</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <Hidden>false</Hidden>',
    '    <Enabled>true</Enabled>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${val(spec.nodePath)}</Command>`,
    `      <Arguments>${val(renderArguments(spec))}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** UTF-16LE with BOM, as `schtasks /create /xml` requires for a `UTF-16` declaration. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** Text content of the first `<name>` element (any namespace prefix, any attributes). */
function element(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`).exec(xml);
  return m ? m[1]! : undefined;
}

/** Splits a Windows-style argument string; double quotes group, no escapes (paths cannot contain `"`). */
function splitArguments(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2]!);
  return out;
}

export interface ParsedTask {
  nodePath: string;
  args: string[];
  /** Always empty: task actions carry no environment. */
  env: Record<string, string>;
  /** `Settings/Enabled`; `true` when absent. */
  enabled: boolean;
  userId?: string;
}

/** Tolerant, element-name-based parse; `undefined` when there is no usable `Exec/Command`. */
export function parseTaskXml(xml: string): ParsedTask | undefined {
  try {
    const exec = element(xml, 'Exec');
    if (exec === undefined) return undefined;
    const command = element(exec, 'Command');
    const nodePath = command === undefined ? '' : unesc(command).trim();
    if (!nodePath) return undefined;
    const rawArgs = element(exec, 'Arguments');
    const settings = element(xml, 'Settings');
    const enabledText = settings === undefined ? undefined : element(settings, 'Enabled');
    const principal = element(xml, 'Principal');
    const userId = principal === undefined ? undefined : element(principal, 'UserId');
    const result: ParsedTask = {
      nodePath,
      args: rawArgs === undefined ? [] : splitArguments(unesc(rawArgs)),
      env: {},
      enabled: enabledText === undefined ? true : unesc(enabledText).trim().toLowerCase() !== 'false',
    };
    if (userId !== undefined) result.userId = unesc(userId).trim();
    return result;
  } catch {
    return undefined;
  }
}
