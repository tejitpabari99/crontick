/**
 * Linux autostart backend — STUB for post-v1.
 *
 * TODO (linux implementation, post-v1):
 *   - install():
 *       1. Create ~/.config/systemd/user/ if absent
 *       2. Write unit file to ~/.config/systemd/user/crontick.service:
 *
 *          [Unit]
 *          Description=crontick daemon
 *          After=default.target
 *
 *          [Service]
 *          Type=simple
 *          ExecStart=/usr/local/bin/crontick-daemon
 *          Restart=on-failure
 *          RestartSec=5
 *
 *          [Install]
 *          WantedBy=default.target
 *
 *       3. Run: systemctl --user daemon-reload
 *       4. Run: systemctl --user enable --now crontick.service
 *
 *   - remove():
 *       1. Run: systemctl --user disable --now crontick.service
 *       2. Delete ~/.config/systemd/user/crontick.service
 *       3. Run: systemctl --user daemon-reload
 *
 *   - status():
 *       Run: systemctl --user is-active crontick.service  (exit 0 = active)
 */
import { NotImplementedInV1Error } from './index.js';
import type { AutostartStatus } from './index.js';

export class LinuxAutostart {
  async install(): Promise<{ ok: true }> {
    throw new NotImplementedInV1Error(
      'linux autostart is planned for post-v1; use manual for now. ' +
      'See https://github.com/crontick/crontick for updates.',
    );
  }

  async remove(): Promise<{ ok: true }> {
    throw new NotImplementedInV1Error(
      'linux autostart is planned for post-v1; use manual for now.',
    );
  }

  async status(): Promise<AutostartStatus> {
    throw new NotImplementedInV1Error(
      'linux autostart is planned for post-v1; use manual for now.',
    );
  }
}
