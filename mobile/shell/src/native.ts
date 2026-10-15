// native.ts — what the shell screens need from the phone (AASC-17).
//
// The screens and flows only ever call these interfaces. On the phone they are
// Capacitor plugins (platform/capacitor.ts, the app's own DeviceVault and
// ShellBridge plugins); in a development build in a browser, in-memory fakes
// (platform/dev.ts); in tests, fakes too. A production build opened in a plain
// browser gets none of them and says it needs the app.
import type { Haptic } from './haptics.js';
import type { HttpRequester } from './http.js';
import type { HttpClient } from './pairingClient.js';
import type { AndroidChannel } from './pushChannels.js';
import type { NotificationLike } from './pushPayload.js';
import type { KeyValueStore, PushPlatform } from './pushRegistration.js';
import type { IncomingImage } from './shareToQueue.js';

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

/** Push (AASC-19). Inert until the app is built with its Firebase config (`configured()`). */
export interface PushHost {
  /** Is the Firebase config built into this app? Without it nothing registers. */
  configured(): Promise<boolean>;
  /** PushNotifications.createChannel for each channel (Android; works without Firebase). */
  createChannels(channels: readonly AndroidChannel[]): Promise<void>;
  platform: PushPlatform;
  /** pushNotificationActionPerformed: a tap on a notification (a cold-start tap is held until this listens). */
  onTap(cb: (notification: NotificationLike) => void): () => void;
}

/** An item shared from another app (AASC-21 M5), as the native inbox hands it over once. */
export interface RawShare {
  text?: string;
  images?: IncomingImage[];
  /** Refused natively before reading it all: too-many, text-too-long, too-large, unsupported, unreadable. */
  problem?: string;
}

export interface ShareSource {
  take(): Promise<RawShare | null>;
}

/** BiometricPrompt / LAContext (AASC-21 M4); the policy is biometricLock.ts. */
export interface BiometricGate {
  available(): Promise<boolean>;
  /** True only when the user passed; cancelling or failing is false. */
  authenticate(reason: string): Promise<boolean>;
  /** Changes on every reboot; null when the phone can't tell (then the lock fails closed). */
  bootId(): Promise<string | null>;
}

/** @capacitor/app 'pause' / 'resume' (not appStateChange: the biometric prompt bounces it). */
export interface AppLifecycle {
  onPause(cb: () => void): () => void;
  onResume(cb: () => void): () => void;
}

/** The home-screen widget's model (widgetModel.ts serializeWidgetModel). */
export interface WidgetStore {
  write(json: string): Promise<void>;
}

/** @capacitor/haptics Haptics.notification (AASC-21 M8). */
export interface HapticsPlatform {
  notify(haptic: Haptic): Promise<void>;
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
  /** Optional native extras: absent in the browser build and where not built yet (iOS). */
  push?: PushHost;
  share?: ShareSource;
  biometric?: BiometricGate;
  lifecycle?: AppLifecycle;
  widget?: WidgetStore;
  haptics?: HapticsPlatform;
}
