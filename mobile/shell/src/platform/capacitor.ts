// capacitor.ts — the shell's native side inside the app (AASC-17, AASC-19, AASC-21).
//
// Two plugins are the app's own (android/app/src/main/java/work/aasc/mobile):
//   DeviceVault  Keystore-encrypted values; refuses any page but the bundled shell
//   ShellBridge  the HttpOnly session cookie, the WebView's allowed Mac origins,
//                the QR scanner, the share inbox, the biometric prompt, the widget,
//                whether push is configured, the Bonjour browse for the LAN rescan;
//                refuses any page but the bundled shell too
// Push, haptics and pause/resume are Capacitor's own plugins.
// iOS has neither yet (needs Xcode): every call rejects there, and pairing says
// the phone couldn't store the key.
import { Capacitor, CapacitorHttp, registerPlugin, type HttpOptions } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, NotificationType } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { detectFormFactor, readFormFactorProbe } from '../formFactor.js';
import type { Haptic } from '../haptics.js';
import type { BrowseResult } from '../lanRescan.js';
import type { HttpRequester } from '../http.js';
import type { AuthSession, PushHost, RawShare, ShellDeps, ShellOs } from '../native.js';
import type { PushPermission } from '../pushRegistration.js';
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
  pushConfigured(): Promise<{ configured: boolean }>;
  takeShare(): Promise<{ share?: RawShare }>;
  biometricStatus(): Promise<{ available: boolean }>;
  authenticate(options: { reason: string }): Promise<{ ok: boolean }>;
  bootId(): Promise<{ bootId?: string | null }>;
  writeWidget(options: { json: string }): Promise<void>;
  discoverMacs(options: { timeoutMs: number }): Promise<BrowseResult>;
}

/** The app's own AuthSession plugin (plan 17): AuthSessionPlugin.swift / AuthSessionPlugin.kt. */
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme?: string; callbackPrefix?: string }): Promise<{ url?: string; cancelled?: boolean }>;
}

const DeviceVault = registerPlugin<DeviceVaultPlugin>('DeviceVault');
const ShellBridge = registerPlugin<ShellBridgePlugin>('ShellBridge');
const AuthSessionNative = registerPlugin<AuthSessionPlugin>('AuthSession');

/** Google sign-in's sheet; anything but a URL string is a cancel. */
const authSession: AuthSession = {
  start: async (url, callback) => {
    const res = await AuthSessionNative.start({
      url,
      ...(callback.scheme ? { callbackScheme: callback.scheme } : {}),
      ...(callback.prefix ? { callbackPrefix: callback.prefix } : {}),
    });
    return typeof res?.url === 'string' ? { url: res.url } : { cancelled: true };
  },
};

/** Plan 08 §6: native HTTP, no redirects followed, 15 s timeouts. */
const TIMEOUTS = { connectTimeout: 15_000, readTimeout: 15_000 } as const;

async function send(options: HttpOptions): Promise<HttpResponse> {
  const res = await CapacitorHttp.request({ ...TIMEOUTS, ...options, disableRedirects: true });
  return { status: res.status, data: res.data };
}

/** Removes a Capacitor listener handle once it resolves. */
function remover(handle: Promise<{ remove(): Promise<void> }>): () => void {
  return () => {
    void handle.then((h) => h.remove());
  };
}

const HAPTIC: Readonly<Record<Haptic, NotificationType>> = {
  warning: NotificationType.Warning,
  success: NotificationType.Success,
  error: NotificationType.Error,
};

/** Push through @capacitor/push-notifications; ShellBridge says whether Firebase is built in. */
function pushHost(os: ShellOs): PushHost {
  const permission = (p: { receive: string }) => p.receive as PushPermission;
  return {
    configured: async () => (await ShellBridge.pushConfigured()).configured,
    createChannels: async (channels) => {
      for (const c of channels) await PushNotifications.createChannel({ ...c });
    },
    platform: {
      os: os === 'ios' ? 'ios' : 'android',
      checkPermission: async () => permission(await PushNotifications.checkPermissions()),
      requestPermission: async () => permission(await PushNotifications.requestPermissions()),
      register: () => PushNotifications.register(),
      unregister: () => PushNotifications.unregister(),
      onToken: (cb) => remover(PushNotifications.addListener('registration', (t) => cb(t.value))),
      onRegistrationError: (cb) => remover(PushNotifications.addListener('registrationError', () => cb())),
      // iOS reads the aps-environment entitlement natively (not built yet); Android is always production.
      environment: () => 'production',
    },
    onTap: (cb) => remover(PushNotifications.addListener('pushNotificationActionPerformed', (a) => cb(a.notification))),
  };
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
      ...(req.timeoutMs === undefined ? {} : { connectTimeout: req.timeoutMs, readTimeout: req.timeoutMs }),
    }),
  };

  return {
    os,
    formFactor: detectFormFactor(os, readFormFactorProbe()),
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
      // Google's code scanner on Android (no camera permission); VisionKit's live scanner on iOS 16+
      // (asks for the camera once). A phone without it answers SCANNER_UNAVAILABLE and the user pastes.
      available: os === 'android' || os === 'ios',
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
    // Android only so far: the native halves for iOS need Xcode.
    // Push (inert until configured), the biometric lock, lifecycle and haptics have both native halves;
    // the share target and the widget are Android-only until the iOS extensions exist (AASC-21).
    ...(os === 'android' || os === 'ios'
      ? {
          push: pushHost(os),
          biometric: {
            available: async () => (await ShellBridge.biometricStatus()).available,
            authenticate: async (reason: string) => (await ShellBridge.authenticate({ reason })).ok,
            bootId: async () => (await ShellBridge.bootId()).bootId ?? null,
          },
          lifecycle: {
            onPause: (cb: () => void) => remover(App.addListener('pause', cb)),
            onResume: (cb: () => void) => remover(App.addListener('resume', cb)),
          },
          haptics: { notify: (h: Haptic) => Haptics.notification({ type: HAPTIC[h] }) },
          // Bonjour `_aasc._tcp` (NsdManager / NWBrowser); lanRescan.ts checks every address it returns.
          discovery: { browse: (timeoutMs: number) => ShellBridge.discoverMacs({ timeoutMs }) },
          // Plan 17: Sign in with Google (ASWebAuthenticationSession / Custom Tab + App Link).
          authSession,
        }
      : {}),
    ...(os === 'android'
      ? {
          share: { take: async () => (await ShellBridge.takeShare()).share ?? null },
          widget: { write: (json: string) => ShellBridge.writeWidget({ json }) },
        }
      : {}),
  };
}
