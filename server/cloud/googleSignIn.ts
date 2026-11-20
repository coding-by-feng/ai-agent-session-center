// googleSignIn.ts — "Sign in with Google" for AASC Cloud, the Mac's half (AASC-61).
//
// The Mac never talks to Google. `begin` makes a verifier `v` and a state `s`, keeps them in memory
// for SIGN_IN_PENDING_MS and returns the backend's start URL carrying c = SHA-256(v), s and this
// Mac's loopback callback. The backend sends the browser back with a one-use pairing code; `finish`
// checks `s`, drops the pending sign-in before any request (single use) and pairs through the
// connector's ordinary path with `v`, which the backend requires for that code. A copied redirect
// is therefore useless, and a callback this process did not start does nothing.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeBackendOrigin } from './client.js';
import { CloudError, type CloudConnection } from './types.js';

export const SIGN_IN_PENDING_MS = 600_000;
export const GOOGLE_CALLBACK_PATH = '/api/resources/cloud/google/callback';

/**
 * How a browser round trip ended. The three `deleted…` results are for a sign-in started to delete
 * the account (plan 18): the backend deleted the account the person picked in the browser, and
 * this Mac then looked at its own connection: gone (`deleted`), still good, so another account was
 * picked (`deleted-other`), or it could not tell (`deleted-unchecked`).
 */
export type SignInFinish =
  | 'connected'
  | 'deleted'
  | 'deleted-other'
  | 'deleted-unchecked'
  | 'no-pending'
  | 'state-mismatch'
  | 'expired'
  | 'failed';
/** What a sign-in is for: connect this Mac (the default), or delete the account that signs in. */
export type SignInIntent = 'connect' | 'delete';
/** What this Mac found after a delete: its own connection is gone, still works, or could not be checked. */
export type AfterDelete = 'gone' | 'still-connected' | 'unknown';

export interface GoogleSignIn {
  begin(input: { backendUrl: string; deviceName: string; returnUrl: string; intent?: 'delete' }): { url: string };
  finish(query: { code?: unknown; state?: unknown; deleted?: unknown }): Promise<SignInFinish>;
  pending(): boolean;
  /** How the last finished round trip ended, until the next `begin`; the page reads it to stop waiting. */
  last(): { intent: SignInIntent; result: SignInFinish } | null;
  cancel(): void;
}

interface Pending {
  verifier: string;
  state: string;
  origin: string;
  deviceName: string;
  expiresAt: number;
  intent: SignInIntent;
}

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const CODE = /^[A-Za-z0-9_-]{22}$/;

/** The callback a Mac hands the backend: its own loopback address and port, this exact path. */
export function isLoopbackCallback(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      url.pathname === GOOGLE_CALLBACK_PATH &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createGoogleSignIn(deps: {
  connect(input: { backendUrl: string; pairingCode: string; deviceName: string; verifier: string }): Promise<CloudConnection>;
  /**
   * After the backend said an account was deleted: look at this Mac's own connection, and forget it
   * when it is gone. Absent means this build cannot start a delete.
   */
  afterDelete?: () => Promise<AfterDelete>;
  now?: () => number;
  log?: (message: string) => void;
}): GoogleSignIn {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let pending: Pending | null = null;
  let last: { intent: SignInIntent; result: SignInFinish } | null = null;
  const ended = (intent: SignInIntent, result: SignInFinish): SignInFinish => {
    last = { intent, result };
    return result;
  };

  return {
    begin({ backendUrl, deviceName, returnUrl, intent }) {
      if (intent === 'delete' && !deps.afterDelete)
        throw new CloudError('invalid_input', 'This build cannot delete the cloud account.', 400);
      const name = deviceName.trim();
      if (!name || name.length > 128 || UNPRINTABLE.test(deviceName))
        throw new CloudError('invalid_input', 'Provide a device name.', 400);
      if (!isLoopbackCallback(returnUrl)) throw new CloudError('invalid_input', 'Invalid sign-in return address.', 400);
      const origin = normalizeBackendOrigin(backendUrl);
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      pending = { verifier, state, origin, deviceName: name, expiresAt: now() + SIGN_IN_PENDING_MS, intent: intent ?? 'connect' };
      last = null;
      const url = new URL('/v1/auth/google/start', origin);
      url.search = new URLSearchParams({
        c: createHash('sha256').update(verifier).digest('base64url'),
        s: state,
        return: returnUrl,
        // The backend then shows "Delete your AASC Cloud account?" and only its button deletes.
        ...(intent === 'delete' ? { intent } : {}),
      }).toString();
      log(intent === 'delete' ? 'Account deletion started in the browser' : 'Google sign-in started');
      return { url: url.href };
    },
    async finish(query) {
      const current = pending;
      if (!current) return 'no-pending';
      // Only the matching state (or expiry) ends the sign-in: any page can make the browser load this
      // URL, and a wrong guess must not cancel the sign-in the user is finishing.
      if (now() >= current.expiresAt) {
        pending = null;
        return ended(current.intent, 'expired');
      }
      if (typeof query.state !== 'string' || !sameText(query.state, current.state)) {
        log('Google sign-in callback refused: state mismatch');
        return 'state-mismatch';
      }
      pending = null;
      if (current.intent === 'delete') {
        // The backend returns `deleted=1` and never a code; anything else is not a finished delete.
        if (query.deleted !== '1' || query.code !== undefined || !deps.afterDelete) return ended('delete', 'failed');
        let found: AfterDelete = 'unknown';
        try {
          found = await deps.afterDelete();
        } catch {
          found = 'unknown';
        }
        log(`Account deletion returned from the browser: this Mac's connection is ${found}`);
        return ended(
          'delete',
          found === 'gone' ? 'deleted' : found === 'still-connected' ? 'deleted-other' : 'deleted-unchecked',
        );
      }
      // A sign-in ends with a code and nothing else: a `deleted` return is not one.
      if (query.deleted !== undefined || typeof query.code !== 'string' || !CODE.test(query.code))
        return ended('connect', 'failed');
      try {
        await deps.connect({
          backendUrl: current.origin,
          pairingCode: query.code,
          deviceName: current.deviceName,
          verifier: current.verifier,
        });
        log('Google sign-in connected this Mac');
        return ended('connect', 'connected');
      } catch (error) {
        log(`Google sign-in pairing failed: ${error instanceof CloudError ? error.code : 'error'}`);
        return ended('connect', 'failed');
      }
    },
    pending: () => pending !== null && now() < pending.expiresAt,
    last: () => (last ? { ...last } : null),
    cancel() {
      pending = null;
    },
  };
}
