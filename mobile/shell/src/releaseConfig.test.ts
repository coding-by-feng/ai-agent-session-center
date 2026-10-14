// The release build's Capacitor settings (AASC-22, plan 08 §5 and §9 "Release config"):
// web inspector and debug logging off, no custom URL scheme, navigation limited.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapacitorConfig } from '@capacitor/cli';

async function loadConfig(release: boolean): Promise<CapacitorConfig> {
  vi.resetModules();
  vi.stubEnv('AASC_RELEASE', release ? '1' : '');
  return (await import('../../capacitor.config')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('release build settings', () => {
  it('turns the web inspector and debug logging off', async () => {
    const config = await loadConfig(true);
    expect(config.loggingBehavior).toBe('none');
    expect(config.ios?.webContentsDebuggingEnabled).toBe(false);
    expect(config.android?.webContentsDebuggingEnabled).toBe(false);
  });

  it('keeps them on for a development build', async () => {
    const config = await loadConfig(false);
    expect(config.loggingBehavior).toBe('debug');
    expect(config.ios?.webContentsDebuggingEnabled).toBe(true);
    expect(config.android?.webContentsDebuggingEnabled).toBe(true);
  });

  it('never allows mixed content, a custom scheme or open navigation', async () => {
    for (const release of [true, false]) {
      const config = await loadConfig(release);
      expect(config.android?.allowMixedContent).toBe(false);
      expect(config.server?.androidScheme).toBe('https');
      expect(config.server?.iosScheme ?? 'capacitor').toBe('capacitor');
      expect(config.server?.url).toBeUndefined();
      for (const pattern of config.server?.allowNavigation ?? []) {
        expect(pattern).not.toBe('*');
        expect(pattern.endsWith('.aasc.work')).toBe(true);
      }
    }
  });

  it('treats only "1" as a release build', async () => {
    vi.resetModules();
    vi.stubEnv('AASC_RELEASE', 'true');
    const config = (await import('../../capacitor.config')).default;
    expect(config.loggingBehavior).toBe('debug');
  });
});
