// phoneCloudBridge.ts — what phone pairing and push need from the cloud connection (AASC-15, AASC-16, AASC-52).
//
// Everything here is optional: with no backend connected, a phone is paired
// with the Mac only and no notification is sent. A failure talking to the
// backend never blocks pairing or a revoke on the Mac; it is logged without
// codes or tokens.
//
//   mintBackendCode     a one-use code an approved, signed-in phone redeems for
//                       its own phone-scoped backend token (AASC-52: asked for
//                       over the phone's Mac session, never put in the QR). It
//                       asks for push and the Mac's address (AASC-60), or for
//                       push alone from a backend that doesn't know the latter
//   retireBackendCode   before a phone gets a new code: revoke the backend device
//                       its last one made, so one phone never holds two
//   revokeBackendPhone  revoking a phone on the Mac also revokes the backend
//                       device it created from its code (found by codeRef)
//   listPhoneDevices    the account's live phone devices, for the desktop's
//   revokeDevice        "not linked to a paired phone" line (cloudPhoneAudit.ts)
//   pushSink            POST /v1/push/notify, only while connected

import {
  createPhonePairingCode,
  findDeviceByPairingCode,
  listBackendDevices,
  notifyPush,
  revokeBackendDevice,
  type BackendDevice,
  type PhonePairingCode,
} from '../cloud/devices.js';
import { CloudError, type CloudClient, type CloudConnector } from '../cloud/types.js';
import type { PushSink } from '../push/pushNotifier.js';

/**
 * All a phone may hold on the backend: register for notifications, and read where this Mac can be reached on
 * Tailscale (AASC-60, Remote access). (The relay scope comes with the relay.)
 */
export const PHONE_BACKEND_SCOPES = ['push:register', 'mac-paths:read'] as const;
/** What a backend without the mac-paths module still accepts. */
export const PUSH_ONLY_SCOPES = ['push:register'] as const;
/**
 * How a backend that doesn't know `mac-paths:read` says so, as this Mac's transport words it. One from before
 * mac-paths checks the request body first and answers 400 `invalid_request`; one that knows the name but doesn't
 * let a phone hold it answers 403 `forbidden`. Nothing else says "ask for less": a network error, a 5xx or a rate
 * limit would fail a push-only request just the same. A Mac whose cloud device lacks `devices:pair` is also told 403
 * `forbidden`, by the route middleware, so both asks fail (two POSTs, then null); the per-phone attempt cap in
 * phoneBackendCode.ts (MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR) bounds that.
 */
const SCOPE_REFUSALS: ReadonlySet<string> = new Set(['invalid_request', 'forbidden']);

/**
 * A backend phone code's life: the backend's shortest. The Mac issues it to a
 * signed-in phone that redeems it at once (AASC-52), so a short life keeps the
 * window small in which a revoked phone could still redeem one.
 */
export const BACKEND_CODE_TTL_SECONDS = 60;
/** How much later than its life a code is surely gone at the backend (the two clocks may differ). */
export const BACKEND_CODE_EXPIRY_MARGIN_MS = 15_000;

/** The longest life the backend gives a phone code (600 s): an expiry past it is not believed. */
export const MAX_BACKEND_CODE_LIFE_MS = 600_000;

/** Pages of `GET /v1/devices` read at most (the owner has few devices). */
const MAX_DEVICE_PAGES = 50;

/** What to do when the Mac couldn't revoke a removed phone's backend device itself. */
const OWNER_REVOKE = 'revoke its backend device there (owner CLI: owner devices / owner revoke).';

export interface BackendPhoneCode {
  /** Backend host, e.g. api.aasc.work (bare host, https implied). */
  host: string;
  code: string;
  /** Non-secret reference the Mac binds to the phone; never sent to the phone. */
  codeRef: string;
  /**
   * This Mac's own backend device id. Every notification the Mac asks the
   * backend to send carries it, so a phone paired with several Macs knows
   * which one a tap belongs to.
   */
  macDeviceId?: string;
  /**
   * When the code stops being redeemable, in ms: the later of the backend's own
   * expiry and a full life counted from when its answer reached this Mac. A slow
   * round trip or a backend clock running behind never makes a live code look gone.
   */
  expiresAt: number;
}

/** What became of a phone's last backend code when it asks for a new one. */
export type RetiredBackendCode = 'revoked' | 'unredeemed' | 'already-revoked';

export interface PhoneCloudBridgeDeps {
  cloud: CloudConnector | null;
  warn: (message: string) => void;
  /** When a backend code this Mac issued expires (BackendCodeLedger.expiresAt), or null when it has no record. */
  expiresAt?: (codeRef: string) => number | null;
  now?: () => number;
}

export interface PhoneCloudBridge {
  /** A saved connection that isn't revoked: worth trying, even before anything has checked it. */
  cloudAvailable(): boolean;
  mintBackendCode(): Promise<BackendPhoneCode | null>;
  /** Throws when the backend can't be asked (the caller then mints nothing). */
  retireBackendCode(codeRef: string): Promise<RetiredBackendCode>;
  revokeBackendPhone(codeRef: string | null): Promise<void>;
  /** Live phone-kind devices of the account, never this Mac's own. Throws on failure. */
  listPhoneDevices(): Promise<BackendDevice[]>;
  /** Revoke one backend device; never this Mac's own. Throws on failure. */
  revokeDevice(deviceId: string): Promise<void>;
  pushSink(): PushSink | null;
}

const reason = (err: unknown): string => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
};

/**
 * A phone code for `PHONE_BACKEND_SCOPES`. When the backend refuses those scopes, once more for `PUSH_ONLY_SCOPES`: the
 * Mac may be updated before its backend, and the phone must still be linked for notifications. `onPushOnly` is told which
 * refusal it was, only once that retry has worked. Any other failure, and a refusal of the retry, goes to the caller.
 */
async function requestPhoneCode(client: CloudClient, onPushOnly: (refusal: string) => void): Promise<PhonePairingCode> {
  const request = (scopes: readonly string[]) =>
    createPhonePairingCode(client, { scopes: [...scopes], ttlSeconds: BACKEND_CODE_TTL_SECONDS });
  try {
    return await request(PHONE_BACKEND_SCOPES);
  } catch (err) {
    if (!(err instanceof CloudError) || !SCOPE_REFUSALS.has(err.code)) throw err;
    const pushOnly = await request(PUSH_ONLY_SCOPES);
    onPushOnly(err.code);
    return pushOnly;
  }
}

export function createPhoneCloudBridge(deps: PhoneCloudBridgeDeps): PhoneCloudBridge {
  const { cloud } = deps;
  const now = deps.now ?? Date.now;
  const connected = (): boolean => cloud !== null && cloud.status().state === 'connected';
  // A saved connection nothing has checked yet ('offline' right after a restart)
  // is tried: the first request is what checks it.
  const available = (): boolean => {
    const status = cloud?.status();
    return !!status?.connection && status.state !== 'revoked' && status.state !== 'disconnected';
  };
  const backendHost = (): string | null => {
    const origin = cloud?.status().connection?.backendOrigin;
    if (!origin) return null;
    try {
      return new URL(origin).host;
    } catch {
      return null;
    }
  };
  const macDeviceId = (): string | null => cloud?.status().connection?.deviceId ?? null;
  /** The connected client, or a `disconnected` error the caller reports. */
  const client = () => {
    if (!cloud || !available()) throw new CloudError('disconnected', 'Cloud is disconnected.', 409);
    return cloud.client;
  };
  async function revokeBackendPhone(codeRef: string | null, recheck: boolean): Promise<void> {
    if (!codeRef) return; // never given a backend code: nothing to revoke there
    // A revoke is the user's own action: skipping it would leave the phone's backend device alive.
    if (!cloud || !available()) {
      deps.warn(`The phone was removed on this Mac, but the backend is not connected: ${OWNER_REVOKE}`);
      return;
    }
    try {
      const device = await findDeviceByPairingCode(cloud.client, codeRef);
      if (device) {
        if (!device.revokedAt) await revokeBackendDevice(cloud.client, device.id);
        return;
      }
    } catch (err) {
      deps.warn(`Could not revoke the phone's backend device (${reason(err)}): ${OWNER_REVOKE}`);
      return;
    }
    // Not redeemed yet. A code still in its life could be redeemed after this
    // revoke (AASC-52), so look once more when the backend has surely let it go.
    const expires = recheck ? deps.expiresAt?.(codeRef) ?? null : null;
    if (expires === null) return;
    // Capped at the backend's maximum life, which also keeps setTimeout clear of its 24.8-day overflow.
    const wait = Math.min(expires - now(), MAX_BACKEND_CODE_LIFE_MS) + BACKEND_CODE_EXPIRY_MARGIN_MS;
    if (expires + BACKEND_CODE_EXPIRY_MARGIN_MS > now()) setTimeout(() => void revokeBackendPhone(codeRef, false), wait).unref?.();
  }

  const sink: PushSink = {
    notify: async (message) => {
      if (!cloud) return;
      await notifyPush(cloud.client, message);
    },
  };

  return {
    cloudAvailable: () => available() && backendHost() !== null,

    async mintBackendCode() {
      const host = backendHost();
      if (!available() || !cloud || !host) return null;
      try {
        const code = await requestPhoneCode(cloud.client, (refusal) =>
          deps.warn(`The backend refused the Mac-address scope (${refusal}): this phone's backend code is push only.`));
        const mac = macDeviceId();
        const backendExpiry = Date.parse(code.expiresAt);
        const answeredAt = now();
        // The later of the backend's expiry and a full life from its answer, but never past the
        // backend's own maximum: a clock running ahead must not block this phone for hours.
        const expiresAt = Math.min(
          Math.max(Number.isFinite(backendExpiry) ? backendExpiry : 0, answeredAt + BACKEND_CODE_TTL_SECONDS * 1000),
          answeredAt + MAX_BACKEND_CODE_LIFE_MS,
        );
        return { host, code: code.code, codeRef: code.codeRef, ...(mac ? { macDeviceId: mac } : {}), expiresAt };
      } catch (err) {
        deps.warn(`No backend code for the phone: ${reason(err)}`);
        return null;
      }
    },

    async retireBackendCode(codeRef) {
      const device = await findDeviceByPairingCode(client(), codeRef);
      if (!device) return 'unredeemed';
      if (device.revokedAt) return 'already-revoked';
      await revokeBackendDevice(client(), device.id);
      return 'revoked';
    },

    revokeBackendPhone: (codeRef) => revokeBackendPhone(codeRef, true),

    async listPhoneDevices() {
      const mac = macDeviceId();
      const phones: BackendDevice[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DEVICE_PAGES; page++) {
        const { devices, nextCursor } = await listBackendDevices(client(), cursor);
        phones.push(...devices.filter((d) => d.kind === 'phone' && !d.revokedAt && d.id !== mac));
        if (!nextCursor) break;
        cursor = nextCursor;
      }
      return phones;
    },

    async revokeDevice(deviceId) {
      const api = client();
      if (deviceId === macDeviceId()) throw new CloudError('invalid_input', 'Not a phone device.', 400);
      await revokeBackendDevice(api, deviceId);
    },

    pushSink() {
      return connected() ? sink : null;
    },
  };
}
