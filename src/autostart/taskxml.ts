import { assertXmlSafe, escapeXml, unescapeXml } from '../utils/xml.js';
import type { AutostartSpec } from './types.js';

/** Pure renderer/parser for the Windows Task Scheduler task definition (XML). */

export const TASK_NAME = '\\crontick\\daemon';

const DESCRIPTION =
  'Starts the crontick scheduler daemon at logon. Created by `crontick autostart enable`; remove with `crontick autostart disable`.';

/** Escapes a value; refuses characters XML 1.0 cannot represent. */
function val(v: string): string {
  assertXmlSafe(v, 'a Task Scheduler definition');
  return escapeXml(v);
}

/**
 * Quotes one argument for CommandLineToArgvW / the MSVC runtime: backslashes directly before the
 * closing quote must be doubled, otherwise `\"` is read as an escaped quote.
 */
function quoteArg(v: string): string {
  return `"${v.replace(/\\+$/, (b) => b + b)}"`;
}

/** Arguments string for the launcher action: `"<cli>" daemon start [--home "<dir>"]`. */
function renderArguments(spec: AutostartSpec): string {
  const home = spec.env['CRONTICK_HOME'];
  const parts = [quoteArg(spec.cliScript), 'daemon', 'start'];
  if (home) parts.push('--home', quoteArg(home));
  return parts.join(' ');
}

/**
 * Renders the logon-task definition for `spec`, scoped to `sid`. Emits exactly the documented
 * settings, nothing else. The caller must write it as UTF-16LE (see `encodeTaskXml`).
 */
export function renderTaskXml(spec: AutostartSpec, sid: string, taskName: string = TASK_NAME): string {
  const user = val(sid);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>crontick</Author>',
    `    <URI>${val(taskName)}</URI>`,
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

/** Splits a Windows-style argument string; double quotes group, trailing backslashes in a quoted token are halved (inverse of `quoteArg`; paths cannot contain `"`). */
function splitArguments(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] !== undefined ? m[1].replace(/\\+$/, (b) => b.slice(0, b.length >> 1)) : m[2]!);
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
    const nodePath = command === undefined ? '' : unescapeXml(command).trim();
    if (!nodePath) return undefined;
    const rawArgs = element(exec, 'Arguments');
    const settings = element(xml, 'Settings');
    const enabledText = settings === undefined ? undefined : element(settings, 'Enabled');
    const principal = element(xml, 'Principal');
    const userId = principal === undefined ? undefined : element(principal, 'UserId');
    const result: ParsedTask = {
      nodePath,
      args: rawArgs === undefined ? [] : splitArguments(unescapeXml(rawArgs)),
      env: {},
      enabled: enabledText === undefined ? true : unescapeXml(enabledText).trim().toLowerCase() !== 'false',
    };
    if (userId !== undefined) result.userId = unescapeXml(userId).trim();
    return result;
  } catch {
    return undefined;
  }
}
