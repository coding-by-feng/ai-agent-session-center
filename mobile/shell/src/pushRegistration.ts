// pushRegistration.ts — ask for notifications and register this phone with the backend (AASC-19).
//
// When: never at first launch. The prompt comes once, right after a Mac
// approves the pairing (the moment the user sees why), or when they tap "Turn on
// notifications" in settings. Every later launch re-sends the token without
// asking, because tokens rotate silently (the backend upserts), and a token that
// rotates while the app runs is re-sent at once.
//
// Where: PUT https://<backend>/v1/push/targets/self with the phone's BACKEND
// device token as `Authorization: Bearer` (scope push:register), body
// { provider, token, environment, appId } (aasc-backend src/contracts/v1.ts,
// PushTargetRegistrationSchema). Unpairing sends DELETE to the same path, no
// body, before the Mac revokes the backend device.
//
// The platform token and the backend token never appear in a state, a message
// or a URL; nothing here logs. An error carries an HTTP status at most.
import type { HttpResponse } from './pairingClient.js';
import { bearer, errorCode, field, jsonHeaders, type HttpRequester } from './http.js';
import { isBackendHost } from './pairingLink.js';

/** = capacitor.config.ts appId; must also be in the backend's AASC_BE_PUSH_APP_IDS. */
export const APP_ID = 'work.aasc.mobile';
/** KeyValueStore key: the after-pairing prompt was shown once. */
export const PUSH_ASKED_KEY = 'aasc.push.asked';

export type PushPermission = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
export type PushEnvironment = 'sandbox' | 'production';

/** Implemented with @capacitor/push-notifications; see README "Native hooks". */
export interface PushPlatform {
  /** Capacitor.getPlatform(): 'ios' gives an APNs token, 'android' an FCM token. */
  readonly os: 'ios' | 'android';
  /** PushNotifications.checkPermissions() → .receive */
  checkPermission(): Promise<PushPermission>;
  /** PushNotifications.requestPermissions() → .receive */
  requestPermission(): Promise<PushPermission>;
  /** PushNotifications.register(); the token arrives through onToken. */
  register(): Promise<void>;
  /** PushNotifications.unregister() */
  unregister(): Promise<void>;
  /** addListener('registration', (t) => cb(t.value)); returns the remover. */
  onToken(cb: (token: string) => void): () => void;
  /** addListener('registrationError', () => cb()); the error text is not passed on. */
  onRegistrationError(cb: () => void): () => void;
  /** iOS: the aps-environment entitlement of this build. Android: always 'production'. */
  environment(): PushEnvironment;
}

/** @capacitor/preferences (Preferences.get/set). Holds nothing secret. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** One backend pairing (pairWithBackend): kept in the DeviceVault, never in Preferences. */
export interface BackendCredential {
  host: string;
  deviceId: string;
  token: string;
}

export type PushSetupState =
  | { state: 'unpaired' }
  | { state: 'backend-not-configured' }
  | { state: 'not-asked' }
  | { state: 'denied' }
  | { state: 'waiting-for-token' }
  | { state: 'registered' }
  | { state: 'push-unconfigured' }
  | { state: 'app-not-allowed' }
  | { state: 'revoked' }
  | { state: 'retry'; status: number | null };

export type PushTrigger = 'launch' | 'paired' | 'settings';

const APNS_TOKEN = /^[0-9A-Fa-f]{64,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9:_-]{1,4096}$/;

export interface RegistrationBody {
  provider: 'apns' | 'fcm';
  token: string;
  environment: PushEnvironment;
  appId: string;
}

/** The PUT body, or null when the platform handed over something the backend would refuse. */
export function registrationBody(os: 'ios' | 'android', token: string, environment: PushEnvironment, appId = APP_ID): RegistrationBody | null {
  if (os === 'ios') return APNS_TOKEN.test(token) ? { provider: 'apns', token, environment, appId } : null;
  return FCM_TOKEN.test(token) ? { provider: 'fcm', token, environment: 'production', appId } : null;
}

/** What the backend's answer to the PUT means for the UI. */
export function classifyRegistration(res: HttpResponse): PushSetupState {
  if (res.status === 200 && typeof field(res.data, ['data', 'targetId']) === 'string') return { state: 'registered' };
  const code = errorCode(res.data);
  if (res.status === 503 && code === 'push_unconfigured') return { state: 'push-unconfigured' };
  if (res.status === 400 && code === 'push_app_not_allowed') return { state: 'app-not-allowed' };
  if (res.status === 401) return { state: 'revoked' };
  return { state: 'retry', status: res.status };
}

const RANK: Readonly<Record<string, number>> = {
  registered: 0, 'push-unconfigured': 1, 'app-not-allowed': 2, retry: 3, revoked: 4,
};

/** With several backend pairings, one success is enough. */
function best(results: readonly PushSetupState[]): PushSetupState {
  return [...results].sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9))[0] ?? { state: 'retry', status: null };
}

export interface PushNotice {
  text: string;
  action: 'enable' | 'open-settings' | 're-pair' | 'retry' | null;
}

/** The line the settings screen shows for a state, or null when there is nothing to say. */
export function pushStateNotice(s: PushSetupState): PushNotice | null {
  switch (s.state) {
    case 'unpaired':
    case 'registered':
      return null;
    case 'backend-not-configured':
      return { text: 'Notifications need the AASC cloud. This Mac was paired without it.', action: null };
    case 'not-asked':
      return { text: 'Get a notification when a session needs you.', action: 'enable' };
    case 'denied':
      return { text: 'Notifications are off for AASC. Turn them on in Settings.', action: 'open-settings' };
    case 'waiting-for-token':
      return { text: 'Turning on notifications…', action: null };
    case 'push-unconfigured':
      return { text: "The AASC cloud doesn't send notifications yet.", action: null };
    case 'app-not-allowed':
      return { text: "This build of the app isn't allowed to receive notifications.", action: null };
    case 'revoked':
      return { text: 'This phone was removed from the AASC cloud. Pair again to get notifications.', action: 're-pair' };
    case 'retry':
      return { text: "Couldn't turn on notifications. AASC will try again.", action: 'retry' };
  }
}

function targetUrl(cred: BackendCredential): string {
  return `https://${cred.host}/v1/push/targets/self`;
}

/** Remove this phone's push target. 'gone': revoked or never registered, nothing left to remove. */
export async function removePushTarget(http: HttpRequester, cred: BackendCredential): Promise<'deleted' | 'gone' | 'failed'> {
  if (!isBackendHost(cred.host)) return 'gone';
  try {
    const res = await http.request({ method: 'DELETE', url: targetUrl(cred), headers: bearer(cred.token) });
    if (res.status === 200) return 'deleted';
    return res.status === 401 || res.status === 404 ? 'gone' : 'failed';
  } catch {
    return 'failed';
  }
}

export interface PushRegistrarDeps {
  platform: PushPlatform;
  store: KeyValueStore;
  http: HttpRequester;
  /** Is any Mac paired, and the backend pairings (one per Mac pairing that carried a backend code). */
  pairing(): { paired: boolean; backend: readonly BackendCredential[] };
  onState?(state: PushSetupState): void;
  /** A backend pairing answered 401: the shell drops that credential. */
  onRevoked?(deviceId: string): void;
  appId?: string;
}

export function createPushRegistrar(deps: PushRegistrarDeps) {
  const { platform, store, http } = deps;
  let current: PushSetupState = { state: 'unpaired' };
  /** The token the backend accepted during this launch (memory only). */
  let registeredToken: string | null = null;
  let inFlight: Promise<PushSetupState> | null = null;

  const set = (next: PushSetupState): PushSetupState => {
    current = next;
    deps.onState?.(next);
    return next;
  };

  /** Not paired, or paired without a backend: nothing to register with. */
  function blocked(): PushSetupState | null {
    const { paired, backend } = deps.pairing();
    if (!paired) return { state: 'unpaired' };
    return backend.length ? null : { state: 'backend-not-configured' };
  }

  async function putTarget(cred: BackendCredential, body: RegistrationBody): Promise<PushSetupState> {
    if (!isBackendHost(cred.host)) return { state: 'retry', status: null };
    try {
      return classifyRegistration(await http.request({ method: 'PUT', url: targetUrl(cred), headers: jsonHeaders(cred.token), body }));
    } catch {
      return { state: 'retry', status: null };
    }
  }

  async function sendToken(token: string): Promise<PushSetupState> {
    const stop = blocked();
    if (stop) return set(stop);
    if (token === registeredToken && current.state === 'registered') return current;
    const body = registrationBody(platform.os, token, platform.environment(), deps.appId ?? APP_ID);
    if (!body) return set({ state: 'retry', status: null });
    const creds = deps.pairing().backend;
    const results = await Promise.all(creds.map((cred) => putTarget(cred, body)));
    results.forEach((r, i) => {
      if (r.state === 'revoked') deps.onRevoked?.(creds[i].deviceId);
    });
    const outcome = best(results);
    if (outcome.state === 'registered') registeredToken = token;
    return set(outcome);
  }

  // Subscribed once, so a rotation while the app runs is caught too.
  const offToken = platform.onToken((token) => {
    inFlight = sendToken(token);
  });
  const offError = platform.onRegistrationError(() => {
    set({ state: 'retry', status: null });
  });

  return {
    state: (): PushSetupState => current,

    /** 'launch' never prompts; 'paired' prompts once ever; 'settings' prompts when the OS still allows it. */
    async start(trigger: PushTrigger): Promise<PushSetupState> {
      const stop = blocked();
      if (stop) return set(stop);
      let permission = await platform.checkPermission();
      if (permission === 'denied') return set({ state: 'denied' });
      if (permission !== 'granted') {
        if (trigger === 'launch') return set({ state: 'not-asked' });
        if (trigger === 'paired' && (await store.get(PUSH_ASKED_KEY))) return set({ state: 'not-asked' });
        await store.set(PUSH_ASKED_KEY, '1');
        permission = await platform.requestPermission();
        if (permission === 'denied') return set({ state: 'denied' });
        if (permission !== 'granted') return set({ state: 'not-asked' });
      }
      set({ state: 'waiting-for-token' });
      try {
        await platform.register();
      } catch {
        return set({ state: 'retry', status: null });
      }
      return current;
    },

    /** Resolves once the latest token has been sent (or at once when none is pending). */
    async settled(): Promise<PushSetupState> {
      return inFlight ? inFlight : current;
    },

    /**
     * Unpair or revoke: remove this pairing's target first (while its backend
     * token still works), then, when no Mac is left, stop push on the phone.
     */
    async unregister(cred: BackendCredential, opts: { lastPairing: boolean }): Promise<'deleted' | 'gone' | 'failed'> {
      const result = await removePushTarget(http, cred);
      if (opts.lastPairing) {
        registeredToken = null;
        try {
          await platform.unregister();
        } catch {
          /* the OS token simply stays unused */
        }
        set({ state: 'unpaired' });
      }
      return result;
    },

    dispose(): void {
      offToken();
      offError();
    },
  };
}

export type PushRegistrar = ReturnType<typeof createPushRegistrar>;
