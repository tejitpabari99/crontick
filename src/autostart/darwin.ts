/**
 * macOS autostart backend — STUB for post-v1.
 *
 * TODO (darwin implementation, post-v1):
 *   - install():
 *       1. Build a launchd plist string for com.crontick.daemon
 *       2. Write to ~/Library/LaunchAgents/com.crontick.daemon.plist
 *       3. Run: launchctl load ~/Library/LaunchAgents/com.crontick.daemon.plist
 *   - remove():
 *       1. Run: launchctl unload ~/Library/LaunchAgents/com.crontick.daemon.plist
 *       2. Delete ~/Library/LaunchAgents/com.crontick.daemon.plist
 *   - status():
 *       Run: launchctl list com.crontick.daemon  (exit 0 = loaded)
 *
 *   Plist template:
 *     <?xml version="1.0" encoding="UTF-8"?>
 *     <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
 *     <plist version="1.0"><dict>
 *       <key>Label</key><string>com.crontick.daemon</string>
 *       <key>ProgramArguments</key>
 *       <array><string>/usr/local/bin/crontick-daemon</string></array>
 *       <key>RunAtLoad</key><true/>
 *       <key>StandardOutPath</key><string>~/.local/state/crontick/logs/daemon.stdout.log</string>
 *       <key>StandardErrorPath</key><string>~/.local/state/crontick/logs/daemon.stderr.log</string>
 *     </dict></plist>
 */
import { NotImplementedInV1Error } from './index.js';
import type { AutostartStatus } from './index.js';

export class DarwinAutostart {
  async install(): Promise<{ ok: true }> {
    throw new NotImplementedInV1Error(
      'darwin autostart is planned for post-v1; use manual for now. ' +
      'See https://github.com/crontick/crontick for updates.',
    );
  }

  async remove(): Promise<{ ok: true }> {
    throw new NotImplementedInV1Error(
      'darwin autostart is planned for post-v1; use manual for now.',
    );
  }

  async status(): Promise<AutostartStatus> {
    throw new NotImplementedInV1Error(
      'darwin autostart is planned for post-v1; use manual for now.',
    );
  }
}
