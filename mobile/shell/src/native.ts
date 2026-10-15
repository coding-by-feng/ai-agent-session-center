// native.ts — what the shell screens need from the phone (AASC-17).
//
// The screens and flows only ever call these interfaces. On the phone they are
// Capacitor plugins (platform/capacitor.ts, the app's own DeviceVault and
// ShellBridge plugins); in a development build in a browser, in-memory fakes
// (platform/dev.ts); in tests, fakes too. A production build opened in a plain
// browser gets none of them and says it needs the app.
import type { HttpRequester } from './http.js';
import type { HttpClient } from './pairingClient.js';
import type { KeyValueStore } from './pushRegistration.js';

/**
 * Keychain / Keystore. The ONLY place a device token or a backend token is
 * kept. The native side refuses every caller but the bundled shell's own page,
 * so the Mac UI loaded later can't read it through the bridge.
 */
export interface DeviceVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The WebView's cookie for a Mac: set natively, HttpOnly, never readable by page script. */
export interface SessionCookies {
  set(origin: string, token: string, maxAgeSeconds: number): Promise<void>;
  clear(origin: string): Promise<void>;
}

export interface QrScanner {
  /** False in a browser build: the screen says scanning needs the app. */
  readonly available: boolean;
  /** The scanned text, or null when the user backed out. */
  scan(): Promise<string | null>;
}

export interface ShellNavigator {
  /** Tell the native layer which plain-HTTP origins the WebView may load: the paired paths. */
  allowOrigins(origins: readonly string[]): Promise<void>;
  /** Leave the shell for a Mac's page. */
  go(url: string): void;
  /** The shell page's own query (`?reauth=1&back=…` when the Mac UI sent the WebView back). */
  search(): string;
  /** The verified link (https://aasc.work/pair#…) that started the app, if any. */
  launchUrl(): Promise<string | null>;
  /** Verified links that arrive while the app runs. Returns the remover. */
  onLinkOpened(cb: (url: string) => void): () => void;
}

export type ShellOs = 'ios' | 'android' | 'web';

export interface ShellDeps {
  os: ShellOs;
  vault: DeviceVault;
  /** Preferences: the saved Macs (names, addresses), nothing secret. */
  store: KeyValueStore;
  /** Native HTTP for the pairing calls (JSON POST, no redirects). */
  http: HttpClient;
  /** Native HTTP for everything else (probe, push target removal). */
  requester: HttpRequester;
  cookies: SessionCookies;
  scanner: QrScanner;
  navigator: ShellNavigator;
  newId(): string;
}
