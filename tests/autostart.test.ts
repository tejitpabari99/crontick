/**
 * Autostart module unit tests.
 *
 * - manual backend: install/status/remove always work
 * - darwin/linux stubs throw NotImplementedInV1Error
 * - win32 (Windows only): registry round-trip with a test value name
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registryMock = vi.hoisted(() => ({
  values: [] as Array<{ name: string; type: string | number; data: string }>,
  createKey: vi.fn(),
  setValue: vi.fn(),
  deleteValue: vi.fn(),
  enumerateValues: vi.fn(),
  HKEY: { HKEY_CURRENT_USER: 'HKCU' },
  RegistryValueType: { REG_SZ: 1, REG_EXPAND_SZ: 2 },
}));

type RegistryGlobal = typeof globalThis & { __crontickRegistryJs?: typeof registryMock };

vi.mock('registry-js', () => ({
  createKey: registryMock.createKey,
  setValue: registryMock.setValue,
  deleteValue: registryMock.deleteValue,
  enumerateValues: registryMock.enumerateValues,
  HKEY: registryMock.HKEY,
  RegistryValueType: registryMock.RegistryValueType,
}));

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

// ── win32 backend ──────────────────────────────────────────────────────────────

describe('Win32Autostart', () => {
  const testValueName = `crontick-daemon-test-${process.pid}`;
  const originalBinary = process.env['CRONTICK_DAEMON_BINARY'];
  const originalHome = process.env['CRONTICK_HOME'];
  const testBinary = 'dist\\daemon\\index.js';
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'crontick-autostart-unit-'));
    registryMock.values = [];
    registryMock.createKey.mockReset();
    registryMock.setValue.mockReset();
    registryMock.deleteValue.mockReset();
    registryMock.enumerateValues.mockReset();
    registryMock.enumerateValues.mockImplementation(() => registryMock.values);
    registryMock.createKey.mockImplementation(() => true);
    registryMock.setValue.mockImplementation((_: string, __: string, name: string, type: string | number, data: string) => {
      registryMock.values = registryMock.values.filter((value) => value.name !== name);
      registryMock.values.push({ name, type, data });
      return true;
    });
    registryMock.deleteValue.mockImplementation((_: string, __: string, name: string) => {
      registryMock.values = registryMock.values.filter((value) => value.name !== name);
      return true;
    });
    (globalThis as RegistryGlobal).__crontickRegistryJs = registryMock;
    process.env['CRONTICK_HOME'] = testHome;
    process.env['CRONTICK_AUTOSTART_TEST_VALUE'] = testValueName;
    process.env['CRONTICK_DAEMON_BINARY'] = testBinary;
  });

  afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
    delete (globalThis as RegistryGlobal).__crontickRegistryJs;
    delete process.env['CRONTICK_AUTOSTART_TEST_VALUE'];
    if (originalBinary !== undefined) {
      process.env['CRONTICK_DAEMON_BINARY'] = originalBinary;
    } else {
      delete process.env['CRONTICK_DAEMON_BINARY'];
    }
    if (originalHome !== undefined) {
      process.env['CRONTICK_HOME'] = originalHome;
    } else {
      delete process.env['CRONTICK_HOME'];
    }
  });

  it('install/status/remove round-trip', async () => {
    const as = createAutostart({ backend: 'win32' });

    const before = await as.status();
    expect(before.installed).toBe(false);
    expect(before.backend).toBe('win32');
    expect(registryMock.enumerateValues).toHaveBeenCalledWith(
      'HKCU',
      'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    );

    const installResult = await as.install();
    expect(installResult).toEqual({ ok: true });
    expect(registryMock.createKey).toHaveBeenCalledWith(
      'HKCU',
      'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    );
    expect(registryMock.setValue).toHaveBeenCalledWith(
      'HKCU',
      'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      testValueName,
      1,
      expect.stringMatching(/^wscript\.exe ".*crontick-daemon\.vbs"$/),
    );

    const after = await as.status();
    expect(after.installed).toBe(true);
    expect(after.backend).toBe('win32');
    const details = after.details as Record<string, unknown>;
    expect(details['registryValue']).toBe(testValueName);
    expect(typeof details['registryData']).toBe('string');
    expect((details['registryData'] as string).includes('wscript.exe')).toBe(true);

    const removeResult = await as.remove();
    expect(removeResult).toEqual({ ok: true });
    expect(registryMock.deleteValue).toHaveBeenCalledWith(
      'HKCU',
      'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      testValueName,
    );

    const afterRemove = await as.status();
    expect(afterRemove.installed).toBe(false);
  });

  it('install is idempotent (double install)', async () => {
    const as = createAutostart({ backend: 'win32' });
    await as.install();
    await expect(as.install()).resolves.toEqual({ ok: true });
    const s = await as.status();
    expect(s.installed).toBe(true);
    expect(registryMock.setValue).toHaveBeenCalledTimes(2);
  });

  it('remove treats missing registry value as success', async () => {
    registryMock.deleteValue.mockImplementation(() => {
      throw new Error('RegDeleteValue: ERROR_FILE_NOT_FOUND');
    });
    const as = createAutostart({ backend: 'win32' });
    await expect(as.remove()).resolves.toEqual({ ok: true });
  });

  it('status treats missing Run key as not installed', async () => {
    registryMock.enumerateValues.mockImplementation(() => {
      throw new Error('The system cannot find the file specified. ERROR_FILE_NOT_FOUND');
    });
    const as = createAutostart({ backend: 'win32' });
    await expect(as.status()).resolves.toMatchObject({ installed: false, backend: 'win32' });
  });
});
