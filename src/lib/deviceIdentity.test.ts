import { describe, it, expect, vi } from 'vitest';
import { getClientId, getWindowOriginId, deriveDeviceLabel } from './deviceIdentity';

/**
 * The device id is per BROWSER PROFILE on purpose (two tabs are one device, so
 * you never fight yourself for control of a session). Anything that must tell
 * one WINDOW from another — the shared queue's echo guard — needs a different
 * handle, which is what getWindowOriginId is.
 */
describe('getWindowOriginId — the identity of THIS window, not this device', () => {
  it('is the device id plus a per-window suffix', () => {
    const id = getWindowOriginId();
    expect(id.startsWith(`${getClientId()}:`)).toBe(true);
    expect(id).not.toBe(getClientId());
  });

  it('is stable for the life of one window', () => {
    expect(getWindowOriginId()).toBe(getWindowOriginId());
  });

  it('differs between two windows of the same device', async () => {
    // A second Electron window or browser tab is a fresh JS context: the same
    // localStorage (so the same device id) but new module state.
    const first = getWindowOriginId();
    // The device id is persisted on first use; the suite's per-test storage reset
    // would otherwise hand the fresh module a different one.
    localStorage.setItem('aasc:client-id', getClientId());
    vi.resetModules();
    const other = await import('./deviceIdentity');

    expect(other.getClientId()).toBe(getClientId());
    expect(other.getWindowOriginId()).not.toBe(first);
  });

  it("fits the server's originClientId limit", () => {
    // server/apiRouter.ts: originClientId is z.string().max(200).
    expect(getWindowOriginId().length).toBeLessThanOrEqual(200);
  });
});

/**
 * The limit above only holds for the ids this code GENERATES (a 36-character UUID twice over). The device
 * half is read back out of localStorage without a bound, so a stored value from anywhere else decides the
 * length — and past the server's 200, every queue push is answered 400, which the fire-and-forget push
 * never shows: the queue just silently stops syncing.
 */
describe('getWindowOriginId — when the stored device id is not one we made', () => {
  const freshModule = async (storedId: string) => {
    localStorage.setItem('aasc:client-id', storedId);
    vi.resetModules();
    return import('./deviceIdentity');
  };

  it('never exceeds 128 characters, however long the stored id is', async () => {
    const mod = await freshModule('x'.repeat(5000));
    expect(mod.getWindowOriginId().length).toBeLessThanOrEqual(128);
  });

  it('cuts the device half and keeps the window half, so two windows still differ', async () => {
    const huge = 'd'.repeat(300);
    const first = await freshModule(huge);
    const second = await freshModule(huge);

    const a = first.getWindowOriginId();
    const b = second.getWindowOriginId();
    expect(a).not.toBe(b);
    expect(a.startsWith('d')).toBe(true);
    // The part after the colon is the per-window nonce, whole.
    expect(a.split(':')[1]).toMatch(/^[0-9a-f-]{36}$|^dev-/);
  });

  it('leaves an ordinary device id untouched', async () => {
    const mod = await freshModule('11111111-2222-3333-4444-555555555555');
    expect(mod.getWindowOriginId().startsWith('11111111-2222-3333-4444-555555555555:')).toBe(true);
  });
});

describe('deriveDeviceLabel — the AASC phone app is the app, not a browser', () => {
  // Real WebView user agents (no "(ios)"/"(android)" suffix): seen on an iPhone 17, Oct 2026.
  const realIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AASC-Mobile/1';
  const realAndroid = 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 AASC-Mobile/1';

  it('names the phone app after itself on both platforms', () => {
    expect(deriveDeviceLabel({ userAgent: realIos, platform: 'iPhone', isElectron: false })).toBe('iPhone · AASC App');
    expect(deriveDeviceLabel({ userAgent: realAndroid, platform: 'Linux armv81', isElectron: false })).toBe('Android · AASC App');
  });

  it('still names a phone browser after the browser', () => {
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
    expect(deriveDeviceLabel({ userAgent: safari, platform: 'iPhone', isElectron: false })).toBe('iPhone · Safari');
  });
});
