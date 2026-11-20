// accountDeviceReconcile.ts — "Sign out that device" means it on this machine too (plan 18).
//
// Signing a device out of the AASC Cloud account ends its account sign-in. But a phone (plan 17) or a computer
// (plan 18) that connected to this machine THROUGH the account holds a key of its own here, which only this
// machine checks. So this machine drops such a record once the account has signed its backend device out.
//
// It acts on positive, exact, validated proof and on nothing else:
//   - a look: a COMPLETE read of the account's device list (cloud/devices.ts readRevokedAccountDevices) that
//     shows the very backend device id a record was enrolled as, with `revokedAt` set;
//   - or the sign-out was made on this machine (`signedOut`, after DELETE …/account/devices/:id succeeded).
// Never on absence from the list, never on a read that failed, was cut short, hit the page cap or could not be
// read for that device, never with no usable connection, never when the connection changed while the list was
// being read, and never for a record of another account than the one the list is of. A read error taken for
// "gone" once wiped a phone's pairings (Nov 17 2026); here that is impossible by construction: every one of
// those cases ends in "do nothing", and a record paired by link or QR is not even looked at
// (deviceAuth.accountDeviceRecords / revokeSignedOut only know records made through the account).
//
// Which account: a record carries the email of the account it was made through, not the account's id. When
// both the record and the connection name an email and they differ, the record is left alone. When either
// names none, the exact id decides alone: backend device ids are unique across accounts, so another account's
// list cannot show it.
//
// Dropping a record is deviceAuth.revokeSignedOut: what a local Revoke does for everything the device could do
// here (its sessions and sockets end, its key is refused), without being the owner's act on this machine. So it
// never reaches accountPhoneRevocation.ts or accountComputerRemoval.ts: no second revoke of that device at the
// backend, no deny list entry (the backend device is dead already; a later sign-in makes a new one), no loop.
// The reconcile itself asks the backend for the list and nothing else. It makes no request at all while this
// machine holds no record made through the account.
//
// When: once when started with a usable connection and right after a sign-in, then every RECONCILE_EVERY_MS
// while the connection stays usable; stopped once a sign-out has worked, and at shutdown. One look at a time
// per connection: a look that started under an earlier connection ends in "do nothing" and never stands in for
// the look the connection in force is owed.

import { readRevokedAccountDevices, type RevokedDevicesRead } from '../cloud/devices.js';
import type { CloudClient, CloudConnector } from '../cloud/types.js';
import { cloudIdentity } from './cloudReadLog.js';
import type { AccountDeviceRecord, DeviceAuth } from './deviceAuth.js';

/** How often this machine looks, while signed in. */
export const RECONCILE_EVERY_MS = 5 * 60_000;

export interface AccountDeviceReconcileDeps {
  cloud: Pick<CloudConnector, 'client' | 'status'>;
  deviceAuth: Pick<DeviceAuth, 'accountDeviceRecords' | 'revokeSignedOut'>;
  /** Told once per record dropped: the device's name and kind, never an id, an address or an email. */
  info: (message: string) => void;
  debug: (message: string) => void;
  /** The read; tests may replace it. */
  read?: (client: CloudClient) => Promise<RevokedDevicesRead>;
}

export interface AccountDeviceReconcile {
  /** Server ready: look once if the connection is usable, then every RECONCILE_EVERY_MS. Never throws. */
  start(): void;
  /** Shutdown: no more looks. */
  stop(): void;
  /** This machine just signed in: look at once, then every RECONCILE_EVERY_MS. */
  connected(): void;
  /** This machine signed out: no more looks. */
  disconnected(): void;
  /**
   * One look now; one at a time, shared by whoever asks meanwhile under the same connection. Never rejects.
   * The number of records dropped.
   */
  run(): Promise<number>;
  /**
   * The account just signed this backend device out through this machine, and the backend said so: drop the
   * records made as that device at once. No list is read. The number of records dropped.
   */
  signedOut(backendDeviceId: string): number;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A connection worth asking: which one it is (backend, account and generation), and the account's email if known. */
interface Usable {
  identity: string;
  email: string | null;
}

export function createAccountDeviceReconcile(deps: AccountDeviceReconcileDeps): AccountDeviceReconcile {
  const read = deps.read ?? ((client: CloudClient) => readRevokedAccountDevices(client));
  let timer: ReturnType<typeof setInterval> | null = null;
  /** The look that is out, and the connection it started under. */
  let inFlight: { identity: string; done: Promise<number> } | null = null;

  /** The connection a look may use, or null: none, revoked or disconnected is never asked. */
  function usable(): Usable | null {
    const status = deps.cloud.status();
    if (!status.connection || status.state === 'revoked' || status.state === 'disconnected') return null;
    const identity = cloudIdentity(status.connection);
    return identity === null ? null : { identity, email: status.connection.accountEmail ?? null };
  }

  function drop(record: AccountDeviceRecord): boolean {
    if (!deps.deviceAuth.revokeSignedOut(record.id)) return false;
    const kind = record.platform === 'desktop' ? 'computer' : 'phone';
    deps.info(`${record.label} was signed out of the AASC Cloud account, so this ${kind} can no longer connect here`);
    return true;
  }

  async function look(before: Usable): Promise<number> {
    // Nothing made through the account here: nothing to ask about.
    if (deps.deviceAuth.accountDeviceRecords().length === 0) return 0;
    const list = await read(deps.cloud.client);
    if (!list.complete) return 0;
    // The list was this connection's account's. If the connection is another one now, it says nothing.
    const after = usable();
    if (after === null || after.identity !== before.identity) return 0;
    let dropped = 0;
    for (const record of deps.deviceAuth.accountDeviceRecords()) {
      if (!list.revoked.has(record.backendDeviceId)) continue;
      if (record.accountEmail && after.email && !same(record.accountEmail, after.email)) continue;
      if (drop(record)) dropped += 1;
    }
    return dropped;
  }

  /** `usable`, for callers that must not throw. */
  function usableNow(): Usable | null {
    try {
      return usable();
    } catch {
      return null;
    }
  }

  function run(): Promise<number> {
    const under = usableNow();
    if (under === null) return Promise.resolve(0);
    // A look still out under this very connection is shared. One that started under an earlier connection is
    // not: it will find the connection changed and do nothing, so this one would otherwise get no look at all.
    if (inFlight?.identity === under.identity) return inFlight.done;
    const mine = {
      identity: under.identity,
      done: look(under)
        .catch(() => {
          // A read that failed, in any way, changes nothing. The next look asks again.
          deps.debug('Could not read the AASC Cloud account’s device list; nothing was changed');
          return 0;
        })
        .finally(() => {
          // Only its own place: a newer connection's look may be the one that is out by now.
          if (inFlight === mine) inFlight = null;
        }),
    };
    inFlight = mine;
    return mine.done;
  }

  function end(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const isUsable = (): boolean => usableNow() !== null;

  function begin(): void {
    if (timer || !isUsable()) return;
    void run();
    timer = setInterval(() => {
      // The connection went, or was revoked: stop until the next sign-in.
      if (!isUsable()) end();
      else void run();
    }, RECONCILE_EVERY_MS);
    timer.unref?.();
  }

  return {
    start: begin,
    stop: end,
    connected() {
      end();
      begin();
    },
    disconnected: end,
    run,
    signedOut(backendDeviceId) {
      if (!backendDeviceId) return 0;
      let dropped = 0;
      for (const record of deps.deviceAuth.accountDeviceRecords()) {
        if (record.backendDeviceId === backendDeviceId && drop(record)) dropped += 1;
      }
      return dropped;
    },
  };
}

/**
 * The connector every sign-in and sign-out goes through, with the reconcile following it: a look right after a
 * sign-in (never holding it up), none after a sign-out that worked. A sign-out that failed stops nothing: if the
 * connection is still there it is still looked at, and if it is not, the next tick stops by itself. `reconcile`
 * is read at the time, since the server makes it after the connector (it needs the device records).
 */
export function withAccountDeviceReconcile(
  cloud: CloudConnector,
  reconcile: () => Pick<AccountDeviceReconcile, 'connected' | 'disconnected'> | null,
): CloudConnector {
  const tell = (what: 'connected' | 'disconnected'): void => {
    try {
      reconcile()?.[what]();
    } catch {
      // Signing in and out never depend on it.
    }
  };
  return {
    ...cloud,
    async connectCloud(input) {
      const connection = await cloud.connectCloud(input);
      tell('connected');
      return connection;
    },
    async disconnectCloud() {
      await cloud.disconnectCloud();
      tell('disconnected');
    },
  };
}
