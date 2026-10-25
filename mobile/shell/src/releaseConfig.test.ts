// The release build's Capacitor settings (AASC-22, plan 08 §5 and §9 "Release config"):
// web inspector and debug logging off, no custom URL scheme, navigation limited.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  // iOS ATS lets http through only to the "local network", and Tailscale's 100.64.0.0/10 is not
  // local to it: the native probe of a tailnet Mac failed in ~10 ms ("…requires the use of a secure
  // connection"), seen on an iPhone 13 Pro, 26 Oct 2026. ATS exceptions take domain names, never IP
  // ranges, so ATS is off and the shell's own rules are the guard (RELEASE.md row 10). The key must
  // stand alone: next to NSAllowsLocalNetworking or …InWebContent, iOS ignores it.
  it('turns ATS off with NSAllowsArbitraryLoads alone, so a tailnet Mac is reachable over http', () => {
    const plist = readFileSync(resolve(__dirname, '../../ios/App/App/Info.plist'), 'utf8');
    const ats = /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? '';
    expect([...ats.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['NSAllowsArbitraryLoads']);
    expect(ats).toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
  });

  it('treats only "1" as a release build', async () => {
    vi.resetModules();
    vi.stubEnv('AASC_RELEASE', 'true');
    const config = (await import('../../capacitor.config')).default;
    expect(config.loggingBehavior).toBe('debug');
  });
});
