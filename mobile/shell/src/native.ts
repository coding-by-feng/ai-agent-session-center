// native.ts — what the shell screens need from the phone (AASC-17).
//
// The screens and flows only ever call these interfaces. On the phone they are
// Capacitor plugins (platform/capacitor.ts, the app's own DeviceVault and
// ShellBridge plugins); in a development build in a browser, in-memory fakes
// (platform/dev.ts); in tests, fakes too. A production build opened in a plain
// browser gets none of them and says it needs the app.
import type { FormFactor } from './formFactor.js';
import type { Haptic } from './haptics.js';
import type { HttpRequester } from './http.js';
import type { BrowseResult } from './lanRescan.js';
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

/** Bonjour on the Wi-Fi the phone is on, for the LAN rescan (lanRescan.ts). */
export interface LanDiscovery {
  /**
   * The IPv4 address and port of each `_aasc._tcp` service found within
   * `timeoutMs` (none when not allowed), and the phone's own IPv4 addresses.
   */
  browse(timeoutMs: number): Promise<BrowseResult>;
}

/** @capacitor/haptics Haptics.notification (AASC-21 M8). */
export interface HapticsPlatform {
  notify(haptic: Haptic): Promise<void>;
}

/** What the system's web sign-in sheet came back with (plan 17). */
export type AuthSessionResult = { url: string } | { cancelled: true };

/**
 * The system's web sign-in sheet (plan 17): ASWebAuthenticationSession on iOS (callback scheme
 * `work.aasc.mobile`, not registered in Info.plist), a Custom Tab plus the verified App Link
 * `https://aasc.work/auth/google` on Android. Resolves with the URL it was sent back to, or cancelled.
 */
export interface AuthSession {
  start(url: string, callback: { scheme?: string; prefix?: string }): Promise<AuthSessionResult>;
}

export type ShellOs = 'ios' | 'android' | 'web';

/** What the floating call bubble shows (Nov 22 2026). */
export interface CallBubble {
  /** The call's clock ("3:12"), or "Paused". */
  label: string;
  state: 'live' | 'paused' | 'muted';
  /** The Voice central, or a session it handed work to, needs the person. */
  alert: boolean;
}

/**
 * The floating call (Nov 22 2026). The call runs in the shell's page, so leaving it for the Mac's page would end it:
 * instead the app lays a second view with the Mac's page over the shell, plus a draggable bubble that brings the call
 * back. That page can't reach any of the app's plugins. Absent in the browser build: Minimize then keeps the compact bar.
 */
export interface CallLayer {
  /** Shows the Mac's page (`url`, a paired Mac's http origin) over the call, with the bubble. A page still loaded
   * from an earlier Minimize on the same origin is shown as it was. False when it couldn't. */
  show(url: string, bubble: CallBubble): Promise<boolean>;
  /** Hides the page and the bubble, keeping the page loaded; the page's URL, or null. */
  hide(): Promise<string | null>;
  /** Drops the page and the bubble; the page's last URL, or null. */
  close(): Promise<string | null>;
  bubble(bubble: CallBubble): void;
  /** The bubble was tapped, Back was pressed on the first page, or the page tried to open the app's own page: the
   * layer has already hidden itself. `url` is where the page was. */
  onExpand(listener: (url: string | null) => void): void;
}

export interface ShellDeps {
  os: ShellOs;
  /** Phone or tablet (formFactor.ts): what the screens call this device. Absent: a phone. */
  formFactor?: FormFactor;
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
  /** Absent in the browser build: the LAN rescan then only sweeps the saved address's network. */
  discovery?: LanDiscovery;
  /** Absent in the browser build: no "Sign in with Google" there (plan 17). */
  authSession?: AuthSession;
  /** Absent in the browser build: Minimize keeps the call's compact bar (Nov 22 2026). */
  callLayer?: CallLayer;
}
