/**
 * Manual autostart backend — prints per-platform instructions.
 * Works on any platform; used as the default on non-Windows in v1.
 */
import type { AutostartStatus } from './index.js';

function instructions(): string {
  switch (process.platform) {
    case 'win32':
      return (
        'Windows: add the following command to your startup folder or HKCU Run key:\n' +
        '  crontick-daemon\n' +
        'Or run: crontick autostart install  (uses HKCU Run + hidden VBS shim)'
      );
    case 'darwin':
      return (
        'macOS (post-v1): create a launchd plist at\n' +
        '  ~/Library/LaunchAgents/com.crontick.daemon.plist\n' +
        'with ProgramArguments pointing to the crontick-daemon binary.\n' +
        'Then run: launchctl load ~/Library/LaunchAgents/com.crontick.daemon.plist\n' +
        '\nFor now, add the following to your shell profile (~/.zprofile or ~/.bash_profile):\n' +
        '  crontick-daemon &'
      );
    case 'linux':
      return (
        'Linux (post-v1): create a systemd user unit at\n' +
        '  ~/.config/systemd/user/crontick.service\n' +
        'Then run: systemctl --user enable --now crontick.service\n' +
        '\nFor now, add the following to your shell profile (~/.profile or ~/.bashrc):\n' +
        '  crontick-daemon &\n' +
        'Or add a @reboot crontab entry: crontab -e\n' +
        '  @reboot crontick-daemon'
      );
    default:
      return (
        'Add `crontick-daemon` to your system startup mechanism.\n' +
        'The daemon listens on a random localhost port; the port is written to the data directory.'
      );
  }
}

export class ManualAutostart {
  async install(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async remove(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async status(): Promise<AutostartStatus> {
    return {
      installed: false,
      backend: 'manual',
      details: { instructions: instructions() },
    };
  }
}
