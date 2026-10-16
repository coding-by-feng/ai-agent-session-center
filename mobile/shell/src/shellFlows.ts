// shellFlows.ts — pair, open, unpair: the shell's work behind the screens (AASC-17).
//
// Only the existing modules talk to a Mac (pairingClient, connectionPlan,
// reauth); this file orders the calls and keeps the two stores in step. No
// outcome carries a token: tokens go from the HTTP answer into the vault or the
// native cookie and nowhere else (not the screen, Preferences, a URL or a log).
import { linkBackend } from './backendLink.js';
import { candidates, isAllowedNavigation, pickReachable, type Candidate } from './connectionPlan.js';
import { openSession, pairWithMac, unpairSelf } from './pairingClient.js';
import type { PairingLink } from './pairingLink.js';
import { removePushTarget } from './pushRegistration.js';
import { returnUrl } from './reauth.js';
import type { ShellDeps } from './native.js';
import {
  allowedOrigins, forgetCredentials, LAST_MAC_KEY, readBackendCredential, readMacCredentials, saveMacs,
  withMac, withoutMac, writeMacCredentials, type SavedMac,
} from './savedMacs.js';

/** = plan 07 §4: a path that doesn't answer GET /api/auth/status within 3 s is down. */
export const PROBE_TIMEOUT_MS = 3_000;
/** = the Mac's one-hour device session (deviceAuth sessionTtlSeconds). */
export const SESSION_COOKIE_MAX_AGE = 3_600;
/** How long opening a Mac waits for the backend device (AASC-52) before going on without it. */
export const LINK_BUDGET_MS = 5_000;

export function probeWith(deps: Pick<ShellDeps, 'requester'>): (origin: string) => Promise<boolean> {
  return async (origin) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    });
    try {
      const answer = deps.requester.request({ method: 'GET', url: `${origin}/api/auth/status` })
        .then((res) => res.status === 200, () => false);
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `work`'s answer, or `fallback` once `ms` have passed (the work itself is not cancelled). */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first path that answers; `onTry` names each one as it is tried (for the status line). */
export async function reach(
  deps: Pick<ShellDeps, 'requester'>, mac: SavedMac, onTry?: (c: Candidate) => void,
): Promise<Candidate | null> {
  const probe = probeWith(deps);
  return pickReachable(candidates(mac), (origin) => {
    const c = candidates(mac).find((x) => x.origin === origin);
    if (c) onTry?.(c);
    return probe(origin);
  });
}

// ── Pairing ──────────────────────────────────────────────────────────────

export type PairOutcome =
  | { ok: true; mac: SavedMac; macs: SavedMac[] }
  | { ok: false; reason: 'unreachable' | 'refused' | 'storage'; message: string };

/**
 * Redeem the Mac's code (it lasts 2 minutes and a failure leaves nothing behind
 * anywhere) and keep the token in the vault. Push comes later: the Mac issues
 * the backend code once it has allowed this phone (signInAndOpen, AASC-52).
 */
export async function pairNewMac(
  deps: ShellDeps, macs: readonly SavedMac[], link: PairingLink,
  opts: { phoneName: string; allowLan: boolean }, onTry?: (c: Candidate) => void,
): Promise<PairOutcome> {
  const draft: SavedMac = {
    id: deps.newId(), name: link.name, port: link.port, lan: link.lan, tailnet: link.tailnet,
    lanAllowed: opts.allowLan && link.lan !== null, backendDeviceId: null,
    status: 'pending', confirmCode: null, phoneName: opts.phoneName, lastPath: null,
  };
  const reached = await reach(deps, draft, onTry);
  if (!reached) {
    return { ok: false, reason: 'unreachable', message: `Can’t reach ${link.name}. Check that Tailscale is on for both devices and AASC is running on the Mac.` };
  }
  let pairing;
  try {
    pairing = await pairWithMac(deps.http, reached.origin, link, opts.phoneName, deps.os === 'ios' ? 'ios' : 'android');
  } catch (err) {
    return { ok: false, reason: 'refused', message: err instanceof Error ? err.message : 'Pairing failed' };
  }
  const creds = { deviceId: pairing.deviceId, deviceToken: pairing.deviceToken };
  try {
    await writeMacCredentials(deps.vault, draft.id, creds);
  } catch {
    await unpairSelf(deps.http, reached.origin, creds); // don't leave a phone on the Mac that can't sign in
    return { ok: false, reason: 'storage', message: 'This phone couldn’t store the pairing key securely, so nothing was paired.' };
  }
  const mac: SavedMac = { ...draft, confirmCode: pairing.confirmCode, lastPath: reached.kind };
  const next = withMac(macs, mac);
  await saveMacs(deps.store, next);
  return { ok: true, mac, macs: next };
}

// ── Opening a Mac ────────────────────────────────────────────────────────

export type OpenOutcome =
  /** `backendLinked`: this sign-in gave the phone a new backend device for push (AASC-52). */
  | { kind: 'navigate'; url: string; mac: SavedMac; macs: SavedMac[]; backendLinked: boolean }
  | { kind: 'pending'; mac: SavedMac }
  /** Wiped from this phone: the Mac removed it, or the vault lost its key. */
  | { kind: 'revoked'; mac: SavedMac; macs: SavedMac[]; why: 'revoked' | 'key-missing' }
  | { kind: 'offline'; mac: SavedMac; tried: Candidate[] }
  | { kind: 'error'; mac: SavedMac; message: string };

/**
 * Sign in on the first path that answers, put the session in the WebView's
 * cookie and say where to go: `back` on that Mac (a path, from reauth), only
 * if the navigation guard allows it. A phone without its backend device for
 * this Mac asks for one first (backendLink.ts): quietly, within `linkMs`, and
 * again next time if it didn't work.
 */
export async function signInAndOpen(
  deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac, back: string, onTry?: (c: Candidate) => void,
  linkMs = LINK_BUDGET_MS,
): Promise<OpenOutcome> {
  const reached = await reach(deps, mac, onTry);
  if (!reached) return { kind: 'offline', mac, tried: candidates(mac) };
  const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
  if (!creds) {
    // The pairing key is gone (vault wiped, biometrics re-enrolled): this Mac must be paired again.
    return { kind: 'revoked', mac, macs: await forgetMac(deps, macs, mac), why: 'key-missing' };
  }
  const session = await openSession(deps.http, reached.origin, creds);
  switch (session.status) {
    case 'pending':
      return { kind: 'pending', mac };
    case 'revoked':
      return { kind: 'revoked', mac, macs: await forgetMac(deps, macs, mac), why: 'revoked' };
    case 'unreachable':
      return { kind: 'offline', mac, tried: candidates(mac) };
    case 'error':
      return { kind: 'error', mac, message: session.message };
    case 'ok':
      break;
  }
  const url = returnUrl(reached.origin, back);
  if (!isAllowedNavigation(url, withMac(macs, { ...mac, status: 'active', lastPath: reached.kind }))) {
    return { kind: 'error', mac, message: 'This address isn’t one this phone paired with, so it wasn’t opened.' };
  }
  const backend = await within(linkBackend(deps, mac, reached.origin, session.token), linkMs, { kind: 'failed' } as const);
  const opened: SavedMac = {
    ...mac, status: 'active', confirmCode: null, lastPath: reached.kind,
    backendDeviceId: (backend.kind === 'linked' ? backend.macDeviceId : null) ?? mac.backendDeviceId ?? null,
  };
  const next = withMac(macs, opened);
  try {
    await deps.cookies.set(reached.origin, session.token, SESSION_COOKIE_MAX_AGE);
    await deps.navigator.allowOrigins(allowedOrigins(next));
  } catch {
    return { kind: 'error', mac, message: 'The app couldn’t prepare the connection. Try again.' };
  }
  await saveMacs(deps.store, next);
  await deps.store.set(LAST_MAC_KEY, opened.id);
  return { kind: 'navigate', url, mac: opened, macs: next, backendLinked: backend.kind === 'linked' };
}

// ── Unpairing ────────────────────────────────────────────────────────────

/** Wipe a Mac from this phone: both tokens, its cookies, its entry. */
export async function forgetMac(deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac): Promise<SavedMac[]> {
  await forgetCredentials(deps.vault, mac.id);
  await Promise.allSettled(candidates({ ...mac, lanAllowed: true }).map((c) => deps.cookies.clear(c.origin)));
  const next = withoutMac(macs, mac.id);
  await saveMacs(deps.store, next);
  await deps.navigator.allowOrigins(allowedOrigins(next)).catch(() => undefined);
  return next;
}

export type UnpairOutcome =
  | { done: true; macs: SavedMac[]; /** The Mac confirmed it dropped this phone. */ toldMac: boolean }
  | { done: false; reason: 'unreachable' };

/**
 * Tell the Mac first (it revokes this phone and its backend device); the push
 * target goes before that, while the backend token still works. Unreachable:
 * nothing changes unless `force`, which wipes the phone's side anyway. A Mac
 * that answers but refuses had already dropped this phone, so the wipe goes on.
 */
export async function unpairMac(
  deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac, opts: { force: boolean },
): Promise<UnpairOutcome> {
  const reached = await reach(deps, mac);
  if (!reached && !opts.force) return { done: false, reason: 'unreachable' };
  const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
  const backend = await readBackendCredential(deps.vault, mac.id).catch(() => null);
  if (backend) await removePushTarget(deps.requester, backend);
  const toldMac = reached && creds ? await unpairSelf(deps.http, reached.origin, creds) : false;
  return { done: true, macs: await forgetMac(deps, macs, mac), toldMac };
}
