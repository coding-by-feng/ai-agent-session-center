// nativeApp.test.ts — AASC-17: how the server's UI behaves inside the AASC phone app.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  nativeAppPlatform, nativeAppVersion, isNativeMobileApp, nativeShellReauthUrl, MOBILE_MEDIA_QUERY, NATIVE_APP_UA_TOKEN,
} from './platform';
import { mayDrivePtyGeometry, defaultWidthMode } from './terminalGeometry';
import { parseSessionDeepLink, stripSessionDeepLink } from './deepLink';
import { WsClient } from './wsClient';

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 AASC-Mobile/1 (android)';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';

describe('native app detection', () => {
  it('recognises the shell’s user-agent token and its platform', () => {
    expect(NATIVE_APP_UA_TOKEN).toBe('AASC-Mobile/');
    expect(nativeAppPlatform(IOS_UA)).toBe('ios');
    expect(nativeAppPlatform(ANDROID_UA)).toBe('android');
    expect(isNativeMobileApp(IOS_UA)).toBe(true);
  });

  it('reads the app’s own version and build from its token (mobile/capacitor.config.ts)', () => {
    expect(nativeAppVersion('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 AASC-Mobile/1.0.0+3')).toEqual({ version: '1.0.0', build: '3' });
    expect(nativeAppVersion('Mozilla/5.0 (Linux; Android 15) Chrome/141 Mobile Safari/537.36 AASC-Mobile/1.2.10+41 (android)')).toEqual({ version: '1.2.10', build: '41' });
    // Every app before 1.0.0 sent a bare `AASC-Mobile/1`: a version with no build.
    expect(nativeAppVersion(IOS_UA)).toEqual({ version: '1', build: null });
    expect(nativeAppVersion(SAFARI_UA)).toBeNull();
    expect(nativeAppVersion('AASC-Mobile/')).toBeNull();
    expect(nativeAppVersion('AASC-Mobile/<script>+1')).toBeNull();
  });

  it('treats a phone browser as a browser, not the app', () => {
    expect(nativeAppPlatform(SAFARI_UA)).toBeNull();
    expect(isNativeMobileApp(SAFARI_UA)).toBe(false);
    expect(isNativeMobileApp('')).toBe(false);
  });

  it('sends re-authentication to the bundled shell, keeping only a path to come back to', () => {
    expect(nativeShellReauthUrl('/?session=abc', IOS_UA)).toBe('capacitor://localhost/?reauth=1&back=%2F%3Fsession%3Dabc');
    expect(nativeShellReauthUrl('/queue', ANDROID_UA)).toBe('https://localhost/?reauth=1&back=%2Fqueue');
    // Never an absolute URL as the way back: only a path on this server.
    expect(nativeShellReauthUrl('https://evil.example/x', IOS_UA)).toBe('capacitor://localhost/?reauth=1&back=%2F');
    expect(nativeShellReauthUrl('/x', SAFARI_UA)).toBeNull();
  });

  // The strings the shells really send (seen on an iPhone 17, Oct 2026): no "(ios)"/"(android)" suffix,
  // whatever capacitor.config.ts says. The platform must come from the rest of the user agent.
  it('reads the platform from a real WebView user agent that has no platform suffix', () => {
    const realIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AASC-Mobile/1';
    const realAndroid = 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 AASC-Mobile/1';
    expect(nativeAppPlatform(realIos)).toBe('ios');
    expect(nativeAppPlatform(realAndroid)).toBe('android');
    expect(nativeShellReauthUrl('/queue', realAndroid)).toBe('https://localhost/?reauth=1&back=%2Fqueue');
    expect(nativeShellReauthUrl('/queue', realIos)).toBe('capacitor://localhost/?reauth=1&back=%2Fqueue');
  });

  it('gives a landscape phone the phone layout, but not a short desktop window', () => {
    expect(MOBILE_MEDIA_QUERY).toBe('(max-width: 480px), (max-height: 480px) and (pointer: coarse)');
  });
});

describe('terminal geometry in the app', () => {
  it('the app never drives the shared PTY, even wider than the phone breakpoint', () => {
    expect(mayDrivePtyGeometry(false, true)).toBe(false);
    expect(mayDrivePtyGeometry(true, true)).toBe(false);
    expect(mayDrivePtyGeometry(false, false)).toBe(true);
  });

  it('the app pans at the PTY width', () => {
    expect(defaultWidthMode(false, true)).toBe('pan');
  });
});

describe('session deep links', () => {
  it('parses a session and tab, defaulting to the terminal', () => {
    expect(parseSessionDeepLink('?session=term-abc_1&tab=conversation')).toEqual({ sessionId: 'term-abc_1', tab: 'conversation' });
    expect(parseSessionDeepLink('?session=abc')).toEqual({ sessionId: 'abc', tab: 'terminal' });
    expect(parseSessionDeepLink('?session=abc&tab=bogus')).toEqual({ sessionId: 'abc', tab: 'terminal' });
  });

  it('ignores missing or malformed ids', () => {
    expect(parseSessionDeepLink('')).toBeNull();
    expect(parseSessionDeepLink('?session=')).toBeNull();
    expect(parseSessionDeepLink('?session=../../etc')).toBeNull();
    expect(parseSessionDeepLink(`?session=${'a'.repeat(65)}`)).toBeNull();
  });

  it('strips only its own parameters', () => {
    expect(stripSessionDeepLink('http://h/?session=a&tab=terminal&x=1#k')).toBe('/?x=1#k');
    expect(stripSessionDeepLink('http://h/queue?session=a')).toBe('/queue');
  });
});

describe('WebSocket URL in the app', () => {
  let urls: string[];
  beforeEach(() => {
    urls = [];
    vi.stubGlobal('WebSocket', class {
      onopen = null; onclose = null; onerror = null; onmessage = null;
      constructor(url: string) { urls.push(url); }
      close() { /* noop */ }
      send() { /* noop */ }
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function connectWith(ua: string): string {
    vi.stubGlobal('navigator', { ...navigator, userAgent: ua });
    const client = new WsClient({ url: '/', token: 'secret-session-token', onMessage: () => {}, onStatus: () => {} });
    client.connect();
    client.dispose();
    return urls[urls.length - 1];
  }

  it('never carries the session token in the app (the cookie authenticates)', () => {
    expect(connectWith(IOS_UA)).not.toContain('token=');
  });

  it('keeps the existing behaviour in a browser', () => {
    expect(connectWith(SAFARI_UA)).toContain('token=secret-session-token');
  });
});
