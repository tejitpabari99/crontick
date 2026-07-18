/**
 * Autostart module unit tests.
 *
 * - manual backend: install/status/remove always work
 * - darwin/linux stubs throw NotImplementedInV1Error
 * - win32 (Windows only): registry round-trip with a test value name
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createAutostart, NotImplementedInV1Error } from '../src/autostart/index.js';

// ── Manual backend ────────────────────────────────────────────────────────────

describe('ManualAutostart', () => {
  it('install returns { ok: true }', async () => {
    const as = createAutostart({ backend: 'manual' });
    await expect(as.install()).resolves.toEqual({ ok: true });
  });

  it('remove returns { ok: true }', async () => {
    const as = createAutostart({ backend: 'manual' });
    await expect(as.remove()).resolves.toEqual({ ok: true });
  });

  it('status returns installed:false with backend:manual and instructions', async () => {
    const as = createAutostart({ backend: 'manual' });
    const s = await as.status();
    expect(s.installed).toBe(false);
    expect(s.backend).toBe('manual');
    expect(typeof (s.details as Record<string, unknown>)?.['instructions']).toBe('string');
    expect(((s.details as Record<string, unknown>)?.['instructions'] as string).length).toBeGreaterThan(0);
  });
});

// ── darwin stub ───────────────────────────────────────────────────────────────

describe('DarwinAutostart (stub)', () => {
  it('install throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'darwin' });
    await expect(as.install()).rejects.toThrow(NotImplementedInV1Error);
    await expect(as.install()).rejects.toThrow(/darwin autostart is planned for post-v1/i);
  });

  it('remove throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'darwin' });
    await expect(as.remove()).rejects.toThrow(NotImplementedInV1Error);
  });

  it('status throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'darwin' });
    await expect(as.status()).rejects.toThrow(NotImplementedInV1Error);
  });
});

// ── linux stub ────────────────────────────────────────────────────────────────

describe('LinuxAutostart (stub)', () => {
  it('install throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'linux' });
    await expect(as.install()).rejects.toThrow(NotImplementedInV1Error);
    await expect(as.install()).rejects.toThrow(/linux autostart is planned for post-v1/i);
  });

  it('remove throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'linux' });
    await expect(as.remove()).rejects.toThrow(NotImplementedInV1Error);
  });

  it('status throws NotImplementedInV1Error', async () => {
    const as = createAutostart({ backend: 'linux' });
    await expect(as.status()).rejects.toThrow(NotImplementedInV1Error);
  });
});

// ── win32 backend (Windows only) ──────────────────────────────────────────────

describe.skipIf(process.platform !== 'win32')('Win32Autostart (Windows only)', () => {
  const testValueName = process.env['CRONTICK_AUTOSTART_TEST_VALUE']
    ?? `crontick-daemon-test-${process.pid}`;

  // Use a dummy binary path for testing — the VBS won't actually work at
  // runtime, but install/status/remove only need a registry round-trip.
  const originalBinary = process.env['CRONTICK_DAEMON_BINARY'];
  const testBinary = 'dist\\daemon\\index.js';

  beforeEach(() => {
    process.env['CRONTICK_AUTOSTART_TEST_VALUE'] = testValueName;
    process.env['CRONTICK_DAEMON_BINARY'] = testBinary;
  });

  afterEach(async () => {
    // Cleanup: always try to remove the test registry value
    try {
      const as = createAutostart({ backend: 'win32' });
      await as.remove();
    } catch { /* ignore cleanup errors */ }
    // Restore env vars
    delete process.env['CRONTICK_AUTOSTART_TEST_VALUE'];
    if (originalBinary !== undefined) {
      process.env['CRONTICK_DAEMON_BINARY'] = originalBinary;
    } else {
      delete process.env['CRONTICK_DAEMON_BINARY'];
    }
  });

  it('install/status/remove round-trip', async () => {
    process.env['CRONTICK_AUTOSTART_TEST_VALUE'] = testValueName;
    const as = createAutostart({ backend: 'win32' });

    // Before install: not installed
    const before = await as.status();
    expect(before.installed).toBe(false);
    expect(before.backend).toBe('win32');

    // Install
    const installResult = await as.install();
    expect(installResult).toEqual({ ok: true });

    // After install: installed
    const after = await as.status();
    expect(after.installed).toBe(true);
    expect(after.backend).toBe('win32');
    const details = after.details as Record<string, unknown>;
    expect(details['registryValue']).toBe(testValueName);
    expect(typeof details['registryData']).toBe('string');
    expect((details['registryData'] as string).includes('wscript.exe')).toBe(true);

    // Remove
    const removeResult = await as.remove();
    expect(removeResult).toEqual({ ok: true });

    // After remove: not installed
    const afterRemove = await as.status();
    expect(afterRemove.installed).toBe(false);
  });

  it('install is idempotent (double install)', async () => {
    process.env['CRONTICK_AUTOSTART_TEST_VALUE'] = testValueName;
    const as = createAutostart({ backend: 'win32' });
    await as.install();
    await expect(as.install()).resolves.toEqual({ ok: true });
    // Should still be installed after double install
    const s = await as.status();
    expect(s.installed).toBe(true);
  });
});
