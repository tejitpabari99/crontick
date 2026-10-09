import { describe, expect, it } from 'vitest';
import { TASK_NAME, encodeTaskXml, parseTaskXml, renderTaskXml } from '../../src/autostart/taskxml.js';
import type { AutostartSpec } from '../../src/autostart/types.js';

const SID = 'S-1-5-21-111-222-333-1001';
const spec: AutostartSpec = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  daemonScript: 'C:\\app\\dist\\daemon\\index.js',
  cliScript: 'C:\\app\\dist\\cli\\index.js',
  env: { CRONTICK_SUPERVISED: '1', PATH: 'C:\\Windows' },
};

describe('task xml renderer', () => {
  it('uses the \\crontick\\daemon task name', () => {
    expect(TASK_NAME).toBe('\\crontick\\daemon');
  });

  it('matches the full snapshot (no --home when CRONTICK_HOME unset)', () => {
    expect(renderTaskXml(spec, SID)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-16"?>
      <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
        <RegistrationInfo>
          <Author>crontick</Author>
          <URI>\\crontick\\daemon</URI>
          <Description>Starts the crontick scheduler daemon at logon. Created by \`crontick autostart enable\`; remove with \`crontick autostart disable\`.</Description>
        </RegistrationInfo>
        <Triggers>
          <LogonTrigger>
            <Enabled>true</Enabled>
            <UserId>S-1-5-21-111-222-333-1001</UserId>
            <Delay>PT30S</Delay>
          </LogonTrigger>
        </Triggers>
        <Principals>
          <Principal id="Author">
            <UserId>S-1-5-21-111-222-333-1001</UserId>
            <LogonType>InteractiveToken</LogonType>
            <RunLevel>LeastPrivilege</RunLevel>
          </Principal>
        </Principals>
        <Settings>
          <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
          <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
          <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
          <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
          <StartWhenAvailable>false</StartWhenAvailable>
          <Hidden>false</Hidden>
          <Enabled>true</Enabled>
          <AllowStartOnDemand>true</AllowStartOnDemand>
        </Settings>
        <Actions Context="Author">
          <Exec>
            <Command>C:\\Program Files\\nodejs\\node.exe</Command>
            <Arguments>&quot;C:\\app\\dist\\cli\\index.js&quot; daemon start</Arguments>
          </Exec>
        </Actions>
      </Task>
      "
    `);
  });

  it('appends --home when CRONTICK_HOME is set', () => {
    const xml = renderTaskXml({ ...spec, env: { CRONTICK_HOME: 'D:\\ct data' } }, SID);
    expect(xml).toContain('<Arguments>&quot;C:\\app\\dist\\cli\\index.js&quot; daemon start --home &quot;D:\\ct data&quot;</Arguments>');
  });

  it('emits only the specified settings', () => {
    const xml = renderTaskXml(spec, SID);
    for (const s of [
      '<LogonType>InteractiveToken</LogonType>',
      '<RunLevel>LeastPrivilege</RunLevel>',
      '<Delay>PT30S</Delay>',
      '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '<Hidden>false</Hidden>',
      '<Author>crontick</Author>',
    ]) expect(xml).toContain(s);
    expect(xml.match(new RegExp(`<UserId>${SID}</UserId>`, 'g'))).toHaveLength(2);
    expect(xml).not.toMatch(/Password|S4U|HighestAvailable|RestartOnFailure/);
  });

  it('escapes & < > " \' in every value', () => {
    const xml = renderTaskXml(
      { ...spec, nodePath: 'C:\\a&b<c>\\n\'d".exe', env: { CRONTICK_HOME: 'D:\\x&y' } },
      'S&<>"\'',
    );
    expect(xml).toContain('<Command>C:\\a&amp;b&lt;c&gt;\\n&apos;d&quot;.exe</Command>');
    expect(xml).toContain('<UserId>S&amp;&lt;&gt;&quot;&apos;</UserId>');
    expect(xml).toContain('D:\\x&amp;y');
  });

  it('rejects control characters', () => {
    expect(() => renderTaskXml({ ...spec, nodePath: 'C:\\a\u0001.exe' }, SID)).toThrow(/control/);
  });
});

describe('task xml parser', () => {
  it('round-trips without --home', () => {
    expect(parseTaskXml(renderTaskXml(spec, SID))).toEqual({
      nodePath: spec.nodePath,
      args: [spec.cliScript, 'daemon', 'start'],
      env: {},
      enabled: true,
      userId: SID,
    });
  });

  it('round-trips --home, spaces, non-ASCII and escapes', () => {
    const s: AutostartSpec = {
      nodePath: 'C:\\Users\\Tést Üser\\nodejs\\node.exe',
      daemonScript: 'x',
      cliScript: 'C:\\Users\\Tést Üser\\a&b\\cli\\index.js',
      env: { CRONTICK_HOME: 'C:\\Users\\Tést Üser\\.crontick \'x\'' },
    };
    const p = parseTaskXml(renderTaskXml(s, SID));
    expect(p?.nodePath).toBe(s.nodePath);
    expect(p?.args).toEqual([s.cliScript, 'daemon', 'start', '--home', s.env['CRONTICK_HOME']]);
  });

  it('reads Settings/Enabled, not the trigger Enabled', () => {
    const xml = renderTaskXml(spec, SID).replace(/(<Hidden>false<\/Hidden>\s*<Enabled>)true/, '$1false');
    expect(parseTaskXml(xml)?.enabled).toBe(false);
  });

  it('is tolerant of prefixes, whitespace and attributes', () => {
    const xml = '<?xml version="1.0"?><Task xmlns="x"><Actions Context="Author"><Exec>\n<Command> C:\\n.exe </Command>\n<Arguments>"C:\\c.js" daemon start</Arguments></Exec></Actions></Task>';
    expect(parseTaskXml(xml)).toMatchObject({ nodePath: 'C:\\n.exe', args: ['C:\\c.js', 'daemon', 'start'] });
  });

  it('returns undefined for garbage, empty, or no Exec', () => {
    expect(parseTaskXml('')).toBeUndefined();
    expect(parseTaskXml('ERROR: The system cannot find the file')).toBeUndefined();
    expect(parseTaskXml('<Task><Actions></Actions></Task>')).toBeUndefined();
    expect(parseTaskXml('<Task><Exec><Command></Command></Exec></Task>')).toBeUndefined();
  });
});

describe('encodeTaskXml', () => {
  it('is UTF-16LE with BOM and decodes back', () => {
    const xml = renderTaskXml(spec, SID);
    const buf = encodeTaskXml(xml);
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]);
    expect(buf.subarray(2).toString('utf16le')).toBe(xml);
    expect(xml).toContain('encoding="UTF-16"');
  });
});
