/**
 * presenceClient — the browser half of multi-device coordination.
 *
 * Two responsibilities:
 *
 *  1. **Stamp every same-origin request with this device's identity.** The
 *     server decides who may run the workspace restore and who holds each
 *     session's write baton, and it can only do that if it knows who is asking.
 *     Rather than thread a header through ~100 `fetch` call sites — where a
 *     single omission silently degrades that call to "anonymous device" and
 *     re-opens the hole — the headers are installed once, globally, by
 *     `installClientIdentityHeaders()`.
 *
 *     The patch is deliberately narrow: it adds two headers, only to
 *     **same-origin** requests, and never overwrites a header the caller set.
 *     The same-origin guard is not cosmetic — attaching a custom header to a
 *     cross-origin request converts it from a CORS "simple request" into a
 *     preflighted one, which would break third-party calls that work today.
 *
 *  2. **Wrap the presence/control endpoints** so callers deal in typed results
 *     instead of raw responses, and so a server that predates this feature
 *     (404 / network error) degrades to "granted" rather than bricking startup.
 */

import { getClientId, getClientLabel } from './deviceIdentity';

export const CLIENT_ID_HEADER = 'x-aasc-client-id';
export const CLIENT_LABEL_HEADER = 'x-aasc-client-label';

let installed = false;

/** True when `url` resolves to this page's origin. */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    // A relative path that fails to parse is still ours by construction.
    return true;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Install the identity headers on `window.fetch`. Idempotent — safe to call
 * from more than one entry point (main window, pop-out windows).
 */
export function installClientIdentityHeaders(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isSameOrigin(urlOf(input))) return original(input, init);

    // Merge into whichever headers container the caller used, so an existing
    // Content-Type / Authorization survives untouched.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(CLIENT_ID_HEADER)) headers.set(CLIENT_ID_HEADER, getClientId());
    if (!headers.has(CLIENT_LABEL_HEADER)) headers.set(CLIENT_LABEL_HEADER, getClientLabel());

    return original(input, { ...init, headers });
  };
}

// ---------------------------------------------------------------------------
// Workspace restore ownership
// ---------------------------------------------------------------------------

export interface RestoreClaimResult {
  granted: boolean;
  reason?: 'already-restored';
  /** Label of the device that owns the restore, when denied. */
  by?: string;
  liveSessions?: number;
}

/**
 * Ask for the right to run the workspace restore. Exactly one device per server
 * lifetime is granted.
 *
 * A transport failure or a 404 resolves to `granted: true`: an older server has
 * no claim endpoint and no second-device problem to solve, and refusing to
 * restore because a request failed would leave the user with an empty workspace
 * and no way to recover it.
 */
export async function claimWorkspaceRestore(): Promise<RestoreClaimResult> {
  try {
    // Identity is sent EXPLICITLY here rather than relying on the global fetch
    // patch. The patch is installed from main.tsx, and any renderer that somehow
    // reaches this call without it would be seen as an anonymous caller — which
    // the server rejects with 400. Since the fallback below has to interpret
    // that, the safest thing is to make it unreachable.
    const res = await fetch('/api/workspace/restore-claim', {
      method: 'POST',
      headers: {
        [CLIENT_ID_HEADER]: getClientId(),
        [CLIENT_LABEL_HEADER]: getClientLabel(),
      },
    });

    // 404 = a server that predates this feature. It has no second-device
    // problem to solve and no clear-all guard either, so restoring is exactly
    // what this client would have done before — not a regression.
    if (res.status === 404) return { granted: true };

    // 200 carries the real verdict (granted true OR false); 400 means we failed
    // to identify ourselves. Deny on 400: an unidentified client that restores
    // anyway would clear-all a workspace it cannot prove it owns, which is the
    // precise failure this whole mechanism exists to prevent. Not restoring is
    // visible and recoverable; destroying live sessions is neither.
    if (res.status === 400) return { granted: false, reason: 'already-restored' };
    if (!res.ok) return { granted: true };

    return (await res.json()) as RestoreClaimResult;
  } catch {
    // A transport failure cannot distinguish "old server" from "new server that
    // would have denied us", but it also means the guarded clear-all is
    // unreachable, so the server-side 409 still backstops us.
    return { granted: true };
  }
}

/** Hand the claim back (failed or no-op restore) so a retry is possible. */
export async function releaseWorkspaceRestore(): Promise<void> {
  try {
    await fetch('/api/workspace/restore-claim/release', {
      method: 'POST',
      headers: {
        [CLIENT_ID_HEADER]: getClientId(),
        [CLIENT_LABEL_HEADER]: getClientLabel(),
      },
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Per-session control baton
// ---------------------------------------------------------------------------

export interface ControlHolderView {
  sessionId: string;
  clientId: string;
  label: string;
  since: number;
  lastActivityAt: number;
  online: boolean;
}

export interface ControlResult {
  ok: boolean;
  controller: ControlHolderView | null;
  reason?: 'held-by-other' | 'not-idle-enough';
  idleMs?: number;
  retryInMs?: number;
}

async function postJson<T>(url: string, body: unknown, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

/** Take the baton. `force` honours the server's idle-takeover window. */
export function claimControl(sessionId: string, force = false): Promise<ControlResult> {
  return postJson<ControlResult>('/api/presence/control/claim', { sessionId, force }, {
    ok: true,
    controller: null,
  });
}

export function releaseControl(sessionId: string): Promise<{ ok: boolean; released: boolean }> {
  return postJson('/api/presence/control/release', { sessionId }, { ok: true, released: false });
}

export function releaseAllControls(): Promise<{ ok: boolean; released: string[] }> {
  return postJson('/api/presence/control/release-all', {}, { ok: true, released: [] });
}

/** Ask the current holder to hand over — cooperative, does not grant anything. */
export function requestControl(sessionId: string): Promise<{ ok: boolean; holder?: ControlHolderView }> {
  return postJson('/api/presence/control/request', { sessionId }, { ok: false });
}

/** As the holder, give the baton to a requesting device. */
export function grantControl(sessionId: string, toClientId: string): Promise<ControlResult> {
  return postJson<ControlResult>('/api/presence/control/grant', { sessionId, toClientId }, {
    ok: false,
    controller: null,
  });
}

export interface PresenceSnapshot {
  devices: {
    clientId: string;
    label: string;
    address: string;
    isLocal: boolean;
    connections: number;
    connectedAt: number;
    lastSeenAt: number;
  }[];
  controllers: ControlHolderView[];
  restoreOwner: string | null;
}

export async function fetchPresence(): Promise<PresenceSnapshot | null> {
  try {
    const res = await fetch('/api/presence');
    if (!res.ok) return null;
    const body = (await res.json()) as { ok: boolean; data: PresenceSnapshot };
    return body.data ?? null;
  } catch {
    return null;
  }
}

/** Test-only: allow re-installing the fetch patch. */
export function _resetForTests(): void {
  installed = false;
}
