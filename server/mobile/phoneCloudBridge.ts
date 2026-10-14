// phoneCloudBridge.ts — what phone pairing and push need from the cloud connection (AASC-15, AASC-16).
//
// Everything here is optional: with no backend connected, pairing is Mac-only
// (the QR carries no backend code) and no notification is sent. A failure
// talking to the backend never blocks pairing or a revoke on the Mac; it is
// logged without codes or tokens.
//
//   mintBackendCode     the backend half of the pairing QR: a one-use code the
//                       phone redeems for its own phone-scoped backend token
//   revokeBackendPhone  revoking a phone on the Mac also revokes the backend
//                       device it created from that code (found by codeRef)
//   pushSink            POST /v1/push/notify, only while connected

import { createPhonePairingCode, findDeviceByPairingCode, notifyPush, revokeBackendDevice } from '../cloud/devices.js';
import type { CloudConnector } from '../cloud/types.js';
import type { BackendPhoneCode } from './mobileRouter.js';
import type { PushSink } from '../push/pushNotifier.js';

/** All a phone may hold on the backend: register for notifications. (The relay scope comes with the relay.) */
export const PHONE_BACKEND_SCOPES = ['push:register'] as const;

/** Longer than the Mac code's two minutes, so the backend half never expires first. */
const BACKEND_CODE_TTL_SECONDS = 600;

export interface PhoneCloudBridgeDeps {
  cloud: CloudConnector | null;
  warn: (message: string) => void;
}

export interface PhoneCloudBridge {
  mintBackendCode(): Promise<BackendPhoneCode | null>;
  revokeBackendPhone(codeRef: string | null): Promise<void>;
  pushSink(): PushSink | null;
}

const reason = (err: unknown): string => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
};

export function createPhoneCloudBridge(deps: PhoneCloudBridgeDeps): PhoneCloudBridge {
  const { cloud } = deps;
  const connected = (): boolean => cloud !== null && cloud.status().state === 'connected';
  const backendHost = (): string | null => {
    const origin = cloud?.status().connection?.backendOrigin;
    if (!origin) return null;
    try {
      return new URL(origin).host;
    } catch {
      return null;
    }
  };
  const sink: PushSink = {
    notify: async (message) => {
      if (!cloud) return;
      await notifyPush(cloud.client, message);
    },
  };

  return {
    async mintBackendCode() {
      const host = backendHost();
      if (!connected() || !cloud || !host) return null;
      try {
        const code = await createPhonePairingCode(cloud.client, {
          scopes: [...PHONE_BACKEND_SCOPES],
          ttlSeconds: BACKEND_CODE_TTL_SECONDS,
        });
        return { host, code: code.code, codeRef: code.codeRef };
      } catch (err) {
        deps.warn(`Phone pairing continues without a backend code: ${reason(err)}`);
        return null;
      }
    },

    async revokeBackendPhone(codeRef) {
      if (!codeRef) return; // paired without a backend code: nothing to revoke there
      if (!connected() || !cloud) {
        deps.warn('The phone was removed on this Mac, but the backend is not connected: revoke its backend device there (owner CLI: owner devices / owner revoke).');
        return;
      }
      try {
        const device = await findDeviceByPairingCode(cloud.client, codeRef);
        if (device && !device.revokedAt) await revokeBackendDevice(cloud.client, device.id);
      } catch (err) {
        deps.warn(`Could not revoke the phone's backend device: ${reason(err)}`);
      }
    },

    pushSink() {
      return connected() ? sink : null;
    },
  };
}
