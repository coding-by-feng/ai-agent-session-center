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

export type SignInFinish = 'connected' | 'no-pending' | 'state-mismatch' | 'expired' | 'failed';

export interface GoogleSignIn {
  begin(input: { backendUrl: string; deviceName: string; returnUrl: string }): { url: string };
  finish(query: { code?: unknown; state?: unknown }): Promise<SignInFinish>;
  pending(): boolean;
  cancel(): void;
}

interface Pending {
  verifier: string;
  state: string;
  origin: string;
  deviceName: string;
  expiresAt: number;
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
  now?: () => number;
  log?: (message: string) => void;
}): GoogleSignIn {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let pending: Pending | null = null;

  return {
    begin({ backendUrl, deviceName, returnUrl }) {
      const name = deviceName.trim();
      if (!name || name.length > 128 || UNPRINTABLE.test(deviceName))
        throw new CloudError('invalid_input', 'Provide a device name.', 400);
      if (!isLoopbackCallback(returnUrl)) throw new CloudError('invalid_input', 'Invalid sign-in return address.', 400);
      const origin = normalizeBackendOrigin(backendUrl);
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      pending = { verifier, state, origin, deviceName: name, expiresAt: now() + SIGN_IN_PENDING_MS };
      const url = new URL('/v1/auth/google/start', origin);
      url.search = new URLSearchParams({
        c: createHash('sha256').update(verifier).digest('base64url'),
        s: state,
        return: returnUrl,
      }).toString();
      log('Google sign-in started');
      return { url: url.href };
    },
    async finish(query) {
      const current = pending;
      if (!current) return 'no-pending';
      // Only the matching state (or expiry) ends the sign-in: any page can make the browser load this
      // URL, and a wrong guess must not cancel the sign-in the user is finishing.
      if (now() >= current.expiresAt) {
        pending = null;
        return 'expired';
      }
      if (typeof query.state !== 'string' || !sameText(query.state, current.state)) {
        log('Google sign-in callback refused: state mismatch');
        return 'state-mismatch';
      }
      pending = null;
      if (typeof query.code !== 'string' || !CODE.test(query.code)) return 'failed';
      try {
        await deps.connect({
          backendUrl: current.origin,
          pairingCode: query.code,
          deviceName: current.deviceName,
          verifier: current.verifier,
        });
        log('Google sign-in connected this Mac');
        return 'connected';
      } catch (error) {
        log(`Google sign-in pairing failed: ${error instanceof CloudError ? error.code : 'error'}`);
        return 'failed';
      }
    },
    pending: () => pending !== null && now() < pending.expiresAt,
    cancel() {
      pending = null;
    },
  };
}
