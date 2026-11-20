// computerEnroll.ts — a computer signed into this machine's AASC Cloud account connects without a pairing link
// (plan 18, stage 2). The same exchange as a phone's account enroll (plan 17, accountEnroll.ts), with a computer
// as the client.
//
// The client asked the backend for a 60 s single-use access ticket bound to (account, client device, THIS
// machine, the client's ephemeral P-256 public key) and sends it here with that key
// (POST /api/mobile/enroll-computer). In order, each step stopping the rest:
//   1. no cloud connection, or it is not the ticket's machine  → 'not-this-machine' (no backend call; the client
//                                                                 tries its next address with the same ticket)
//   2. account computers are not offered here                  → 'off'
//   3. MAX_PROVISIONAL_ACCOUNT_ROWS account devices already wait (for Allow or a first sign-in) → 'busy'
//   4. hooks.beforeRedeem (the route records a login strike here, cleared on success)
//   5. the backend redeems the ticket, authenticated as this machine → its refusals pass through
//   6. a client that is a phone → 'invalid': a phone connects through plan 17 and stays under the phone rules
//   7. the client's key must hash to the ticket's key hash        → else 'invalid' (a relay swapped keys)
//   8. a client the owner revoked here (deny list, accountComputerRemoval.ts) → 'client-revoked'. After the key,
//      so only the holder of the key the ticket was made for learns that its client was revoked
//   9. a computer record named by the backend's client name (deviceAuth.enrollComputer): PENDING with a confirm
//      code while the owner's choice is `ask` (the default), exactly like a computer paired by link, or ACTIVE
//      at once with `auto`
//  10. the token is sealed to the client's key (enrollSeal.ts, domain 'aasc-access-v1') with the address this
//      request is bound to (boundAddress.ts) in the AEAD's associated data, so the client accepts only an
//      answer from the machine it dialled itself, and the token never crosses the network in clear.
//
// The sealed plaintext: utf8(JSON.stringify({ deviceId, deviceToken, status: 'pending' | 'active',
// confirmCode: string | null })). The status and the confirm code are sealed too, so a box on the way can
// neither show the person another code nor tell the client it was allowed.
//
// Nothing here logs a ticket, key, nonce, secret, token, code or email.

import { MachineRedeemError, type MachineRedeemReason, type RedeemedMachineTicket } from '../cloud/machines.js';
import type { AccountDenyList } from './accountPhoneRevocation.js';
import {
  MAX_PROVISIONAL_ACCOUNT_ROWS, TooManyWaitingAccountDevicesError, toView, type DeviceAuth, type MobileDeviceView,
} from './deviceAuth.js';
import { prepareSeal, sameHex, sealAnswer, sha256hex } from './enrollSeal.js';

export const ACCESS_SEAL_INFO = 'aasc-access-v1';

/** `ask`: Allow once on this machine, per computer. `auto`: the account's computers connect without asking. */
export type ComputerEnrollMode = 'ask' | 'auto';

export interface ComputerEnrollInput {
  machineId: string;
  ticket: string;
  /** The client's ephemeral public key: a 65-byte uncompressed P-256 point, base64url. */
  clientKey: string;
  /** 64 hex characters the client chose. */
  nonce: string;
  /** The `host:port` this request is bound to (boundAddress.ts): this machine's to say, never the client's. */
  boundAddress: string;
}

export interface ComputerEnrollAnswer {
  machineKey: string;
  iv: string;
  sealed: string;
}

export type ComputerEnrollRefusal = 'off' | 'not-this-machine' | 'busy' | MachineRedeemReason;

export type ComputerEnrollOutcome =
  | { ok: true; answer: ComputerEnrollAnswer; device: MobileDeviceView }
  | { ok: false; reason: ComputerEnrollRefusal };

export interface ComputerEnrollDeps {
  /** May the account's computers connect here at all: pairing offered, and this machine shown to its account. */
  offered: () => boolean;
  /** The owner's choice (machineAccountSettings.ts `computerEnroll`), read at every enroll. */
  mode: () => ComputerEnrollMode;
  /** This machine's cloud connection; null when there is no connector at all. */
  cloudStatus: () => { connection: { deviceId: string } | null } | null;
  /** Redeem the ticket at the backend as this machine (cloud/machines.ts); throws MachineRedeemError. */
  redeem: (ticket: string) => Promise<RedeemedMachineTicket>;
  deviceAuth: Pick<DeviceAuth, 'enrollComputer' | 'waitingAccountCount'>;
  /** Clients the owner revoked here on purpose. Omitted: none. */
  denyList?: Pick<AccountDenyList, 'has'>;
  info?: (message: string) => void;
}

export interface ComputerEnrollHooks {
  /** Called once the local checks pass, just before the backend is asked: the route's login strike. */
  beforeRedeem?: () => void;
}

export function createComputerEnroll(deps: ComputerEnrollDeps) {
  return {
    async enroll(input: ComputerEnrollInput, hooks: ComputerEnrollHooks = {}): Promise<ComputerEnrollOutcome> {
      // NOT_THIS_MACHINE first: the client moves on to its next address, whatever this machine's settings say.
      const connection = deps.cloudStatus()?.connection ?? null;
      if (!connection || connection.deviceId !== input.machineId) return { ok: false, reason: 'not-this-machine' };
      if (!deps.offered()) return { ok: false, reason: 'off' };
      if (deps.deviceAuth.waitingAccountCount() >= MAX_PROVISIONAL_ACCOUNT_ROWS) return { ok: false, reason: 'busy' };

      hooks.beforeRedeem?.();
      let redeemed: RedeemedMachineTicket;
      try {
        redeemed = await deps.redeem(input.ticket);
      } catch (error) {
        return { ok: false, reason: error instanceof MachineRedeemError ? error.reason : 'cloud-failed' };
      }
      if (redeemed.clientKind === 'phone') return { ok: false, reason: 'invalid' };

      const clientKey = Buffer.from(input.clientKey, 'base64url');
      if (!sameHex(sha256hex(clientKey), redeemed.clientKeyHash)) return { ok: false, reason: 'invalid' };
      const prepared = prepareSeal(ACCESS_SEAL_INFO, clientKey, Buffer.from(redeemed.sealSecret, 'base64url'), input.nonce);
      if (!prepared) return { ok: false, reason: 'invalid' };
      // Only now, to the key the ticket was made for: whoever swapped in a key of its own has already been
      // told "invalid", and learns nothing about the client.
      if (deps.denyList?.has(redeemed.clientDeviceId)) return { ok: false, reason: 'client-revoked' };

      let enrolled: ReturnType<DeviceAuth['enrollComputer']>;
      try {
        enrolled = deps.deviceAuth.enrollComputer({
          label: redeemed.clientName,
          accountEmail: redeemed.email,
          backendDeviceId: redeemed.clientDeviceId,
          approve: deps.mode(),
        });
      } catch (error) {
        if (error instanceof TooManyWaitingAccountDevicesError) return { ok: false, reason: 'busy' };
        throw error;
      }
      const { device, deviceToken } = enrolled;
      const pending = device.status === 'pending';
      const sealed = sealAnswer(ACCESS_SEAL_INFO, prepared, input.nonce, input.boundAddress, JSON.stringify({
        deviceId: device.id,
        deviceToken,
        status: pending ? 'pending' : 'active',
        confirmCode: pending ? device.confirmCode : null,
      }));
      deps.info?.(`Computer ${pending ? 'asks to connect' : 'connected'} via account (${device.status}): ${device.label}`);
      return {
        ok: true,
        answer: { machineKey: sealed.ownKey, iv: sealed.iv, sealed: sealed.sealed },
        device: toView(device),
      };
    },
  };
}

export type ComputerEnroll = ReturnType<typeof createComputerEnroll>;
