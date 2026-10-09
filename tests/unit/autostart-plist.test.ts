import { describe, expect, it } from 'vitest';
import { PLIST_LABEL, parsePlist, plistPaths, renderPlist } from '../../src/autostart/plist.js';
import type { AutostartSpec } from '../../src/autostart/types.js';

const spec: AutostartSpec = {
  nodePath: '/usr/local/bin/node',
  daemonScript: '/opt/crontick/dist/daemon/index.js',
  cliScript: '/opt/crontick/dist/cli/index.js',
  env: { CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/data/ct', PATH: '/usr/bin:/bin' },
};
const paths = { logsDir: '/data/ct/logs', dataDir: '/data/ct' };

describe('plist renderer', () => {
  it('uses the dev.crontick.daemon label', () => {
    expect(PLIST_LABEL).toBe('dev.crontick.daemon');
  });

  it('matches the full snapshot', () => {
    expect(renderPlist(spec, PLIST_LABEL, paths)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
      	<key>Label</key>
      	<string>dev.crontick.daemon</string>
      	<key>ProgramArguments</key>
      	<array>
      		<string>/usr/local/bin/node</string>
      		<string>/opt/crontick/dist/daemon/index.js</string>
      	</array>
      	<key>EnvironmentVariables</key>
      	<dict>
      		<key>CRONTICK_SUPERVISED</key>
      		<string>1</string>
      		<key>CRONTICK_HOME</key>
      		<string>/data/ct</string>
      		<key>PATH</key>
      		<string>/usr/bin:/bin</string>
      	</dict>
      	<key>RunAtLoad</key>
      	<true/>
      	<key>KeepAlive</key>
      	<dict>
      		<key>SuccessfulExit</key>
      		<false/>
      	</dict>
      	<key>ThrottleInterval</key>
      	<integer>30</integer>
      	<key>AbandonProcessGroup</key>
      	<true/>
      	<key>StandardOutPath</key>
      	<string>/data/ct/logs/launchd.out.log</string>
      	<key>StandardErrorPath</key>
      	<string>/data/ct/logs/launchd.err.log</string>
      	<key>WorkingDirectory</key>
      	<string>/data/ct</string>
      </dict>
      </plist>
      "
    `);
  });

  it('contains exactly the PRD keys and none of the forbidden ones', () => {
    const xml = renderPlist(spec, PLIST_LABEL, paths);
    const topKeys = [...xml.matchAll(/^\t<key>([^<]+)<\/key>$/gm)].map((m) => m[1]);
    expect(topKeys).toEqual([
      'Label',
      'ProgramArguments',
      'EnvironmentVariables',
      'RunAtLoad',
      'KeepAlive',
      'ThrottleInterval',
      'AbandonProcessGroup',
      'StandardOutPath',
      'StandardErrorPath',
      'WorkingDirectory',
    ]);
    for (const k of ['ProcessType', 'Disabled', 'LimitLoadToSessionType', 'AssociatedBundleIdentifiers', 'ExitTimeOut']) {
      expect(xml).not.toContain(`<key>${k}</key>`);
    }
    expect(xml).toContain('<key>SuccessfulExit</key>\n\t\t<false/>');
    expect(xml).toContain('<key>ThrottleInterval</key>\n\t<integer>30</integer>');
    expect(xml).toContain('<key>AbandonProcessGroup</key>\n\t<true/>');
    expect(xml).toContain('<string>/data/ct/logs/launchd.out.log</string>');
    expect(xml).toContain('<string>/data/ct/logs/launchd.err.log</string>');
  });

  it('copies env unchanged (no PATH added) and omits CRONTICK_HOME when unset', () => {
    const noHome: AutostartSpec = { ...spec, env: { CRONTICK_SUPERVISED: '1' } };
    const xml = renderPlist(noHome, PLIST_LABEL, paths);
    expect(xml).not.toContain('CRONTICK_HOME');
    expect(xml).not.toContain('<key>PATH</key>');
    expect(parsePlist(xml)?.env).toEqual({ CRONTICK_SUPERVISED: '1' });
  });

  it('rejects control characters in env keys (regression)', () => {
    const s: AutostartSpec = { ...spec, env: { 'A\u0001B': '1' } };
    expect(() => renderPlist(s, PLIST_LABEL, paths)).toThrow(/control characters/);
  });

  it('escapes & < > " \' everywhere', () => {
    const nasty = `/a&b<c>d"e'f`;
    const s: AutostartSpec = { ...spec, nodePath: nasty, daemonScript: `${nasty}/d.js`, env: { K: nasty, 'A&B': '1' } };
    const xml = renderPlist(s, `l&<>"'`, { logsDir: nasty, dataDir: nasty });
    expect(xml).toContain('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(xml).not.toContain('a&b');
    expect(xml).not.toMatch(/<string>[^<]*<[a-z]*[^/]/);
    expect(xml).toContain('<key>A&amp;B</key>');
    expect(xml).toContain('<string>l&amp;&lt;&gt;&quot;&apos;</string>');
    expect(parsePlist(xml)).toEqual({ nodePath: nasty, args: [`${nasty}/d.js`], env: { K: nasty, 'A&B': '1' } });
  });

  it('round-trips to command {nodePath,args,env}', () => {
    expect(parsePlist(renderPlist(spec, PLIST_LABEL, paths))).toEqual({
      nodePath: spec.nodePath,
      args: [spec.daemonScript],
      env: spec.env,
    });
  });

  it('preserves unicode and spaces', () => {
    const s: AutostartSpec = { ...spec, nodePath: '/Users/Jo Ñ/node', env: { X: 'a b  ü' } };
    expect(parsePlist(renderPlist(s, PLIST_LABEL, paths))).toMatchObject({ nodePath: '/Users/Jo Ñ/node', env: { X: 'a b  ü' } });
  });

  it('parsePlist returns undefined for garbage or missing ProgramArguments', () => {
    expect(parsePlist('')).toBeUndefined();
    expect(parsePlist('not xml')).toBeUndefined();
    expect(parsePlist('<plist><dict><key>Label</key><string>x</string></dict></plist>')).toBeUndefined();
  });

  it('plistPaths derives logsDir/dataDir from spec.env.CRONTICK_HOME', () => {
    expect(plistPaths(spec)).toEqual({ logsDir: '/data/ct/logs', dataDir: '/data/ct' });
  });
});
