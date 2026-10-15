// capacitor.ts — the shell's native side inside the app (AASC-17).
//
// Two plugins are the app's own (android/app/src/main/java/work/aasc/mobile):
//   DeviceVault  Keystore-encrypted values; refuses any page but the bundled shell
//   ShellBridge  the HttpOnly session cookie, the WebView's allowed Mac origins,
//                the QR scanner; refuses any page but the bundled shell too
// iOS has neither yet (needs Xcode): every call rejects there, and pairing says
// the phone couldn't store the key.
import { Capacitor, CapacitorHttp, registerPlugin, type HttpOptions } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import type { HttpRequester } from '../http.js';
import type { ShellDeps, ShellOs } from '../native.js';
import type { HttpClient, HttpResponse } from '../pairingClient.js';

interface DeviceVaultPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface ShellBridgePlugin {
  setSessionCookie(options: { origin: string; token: string; maxAgeSeconds: number }): Promise<void>;
  clearSessionCookie(options: { origin: string }): Promise<void>;
  allowOrigins(options: { origins: string[] }): Promise<void>;
  scanQr(): Promise<{ value: string | null }>;
}

const DeviceVault = registerPlugin<DeviceVaultPlugin>('DeviceVault');
const ShellBridge = registerPlugin<ShellBridgePlugin>('ShellBridge');

/** Plan 08 §6: native HTTP, no redirects followed, 15 s timeouts. */
const TIMEOUTS = { connectTimeout: 15_000, readTimeout: 15_000 } as const;

async function send(options: HttpOptions): Promise<HttpResponse> {
  const res = await CapacitorHttp.request({ ...options, ...TIMEOUTS, disableRedirects: true });
  return { status: res.status, data: res.data };
}

export function capacitorDeps(): ShellDeps {
  const os = Capacitor.getPlatform() as ShellOs;
  const http: HttpClient = {
    // The Mac's public routes take JSON only (415 otherwise), and Android sends no body without the type.
    post: (url, body) => send({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, data: body }),
  };
  const requester: HttpRequester = {
    request: (req) => send({
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      ...(req.body === undefined ? {} : { data: req.body }),
    }),
  };

  return {
    os,
    vault: {
      get: async (key) => (await DeviceVault.get({ key })).value ?? null,
      set: (key, value) => DeviceVault.set({ key, value }),
      delete: (key) => DeviceVault.remove({ key }),
    },
    store: {
      get: async (key) => (await Preferences.get({ key })).value,
      set: (key, value) => Preferences.set({ key, value }),
    },
    http,
    requester,
    cookies: {
      set: (origin, token, maxAgeSeconds) => ShellBridge.setSessionCookie({ origin, token, maxAgeSeconds }),
      clear: (origin) => ShellBridge.clearSessionCookie({ origin }),
    },
    scanner: {
      // Google's code scanner on Android (no camera permission); nothing on iOS yet.
      available: os === 'android',
      scan: async () => (await ShellBridge.scanQr()).value ?? null,
    },
    navigator: {
      allowOrigins: (origins) => ShellBridge.allowOrigins({ origins: [...origins] }),
      go: (url) => window.location.assign(url),
      search: () => window.location.search,
      launchUrl: async () => (await App.getLaunchUrl())?.url ?? null,
      onLinkOpened: (cb) => {
        const handle = App.addListener('appUrlOpen', (e) => cb(e.url));
        return () => {
          void handle.then((h) => h.remove());
        };
      },
    },
    newId: () => crypto.randomUUID(),
  };
}
