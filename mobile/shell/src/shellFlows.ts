// shellFlows.ts — pair, open, unpair: the shell's work behind the screens (AASC-17).
//
// Only the existing modules talk to a Mac (pairingClient, connectionPlan,
// reauth); this file orders the calls and keeps the two stores in step. No
// outcome carries a token: tokens go from the HTTP answer into the vault or the
// native cookie and nowhere else (not the screen, Preferences, a URL or a log).
import { linkBackend } from './backendLink.js';
import { findViaCloud } from './cloudFind.js';
import { candidates, isAllowedNavigation, pickReachable, type Candidate } from './connectionPlan.js';
import { rediscover } from './lanRescan.js';
import {
  fetchMacPaths, openSession, pairWithMac, PATHS_BUDGET_MS, unpairSelf, type MacCredentials, type MacPaths, type SessionResult,
} from './pairingClient.js';
import { isTailnetAddress, type PairingLink } from './pairingLink.js';
import { removePushTarget } from './pushRegistration.js';
import { returnUrl } from './reauth.js';
import type { ShellDeps } from './native.js';
import {
  allowedOrigins, clearBackendRelink, forgetBackendRelink, forgetCredentials, LAST_MAC_KEY, loadUnknownTwins, needsBackendRelink, readBackendCredential,
  readMacCredentials, saveMacs, saveUnknownTwins, withMac, withoutMac, writeMacCredentials, type SavedMac,
} from './savedMacs.js';

/** = plan 07 §4: a path that doesn't answer GET /api/auth/status within 3 s is down. */
export const PROBE_TIMEOUT_MS = 3_000;
/** = the Mac's one-hour device session (deviceAuth sessionTtlSeconds). */
export const SESSION_COOKIE_MAX_AGE = 3_600;
/** How long opening a Mac waits for the backend device (AASC-52) before going on without it. */
export const LINK_BUDGET_MS = 5_000;
/** How long opening a Mac waits for its Tailscale address (AASC-60); defined with the request it times out. */
export { PATHS_BUDGET_MS };
/** How long opening a Mac spends retiring this phone's older rows for it before going on. */
export const RETIRE_BUDGET_MS = 5_000;

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

/**
 * `work`'s answer, or `fallback` once `ms` have passed. Either way its signal is
 * aborted on return, so work still running then (outside the caller's serialized
 * turn) drops its result instead of writing it.
 */
async function within<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, fallback: T): Promise<T> {
  const cut = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work(cut.signal), late]);
  } finally {
    clearTimeout(timer);
    cut.abort();
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
  /** `backendLinked`: this sign-in gave the phone a new backend device for push (AASC-52). `retired`: it removed
   *  other rows for this Mac (releasedTwins), and their backend credentials with them. */
  | { kind: 'navigate'; url: string; mac: SavedMac; macs: SavedMac[]; backendLinked: boolean; retired: boolean }
  | { kind: 'pending'; mac: SavedMac }
  /** Wiped from this phone: the Mac removed it, or the vault lost its key. */
  | { kind: 'revoked'; mac: SavedMac; macs: SavedMac[]; why: 'revoked' | 'key-missing' }
  | { kind: 'offline'; mac: SavedMac; tried: Candidate[] }
  /** `macs`: the saved list, when this sign-in had already retired other rows (releasedTwins). */
  | { kind: 'error'; mac: SavedMac; message: string; macs?: SavedMac[] };

export interface OpenOptions {
  /** How long to wait for the backend device (LINK_BUDGET_MS). */
  linkMs?: number;
  /** How long to spend retiring other rows for this Mac (RETIRE_BUDGET_MS). */
  retireMs?: number;
  /** False once the user has moved on (cancelled, another screen): no other row is retired after that. */
  proceed?: () => boolean;
  /** Every saved path failed and the phone is looking for the Mac: on this network (lanRescan.ts) or through AASC Cloud (cloudFind.ts). */
  onSearch?: () => void;
}

type Reached = { mac: SavedMac; reached: Candidate };

/**
 * For an approved Mac that no saved path reaches: where it is now. First on this
 * network (rediscover), when the home network is allowed for it: the Mac at a new
 * home address, with `lan` moved to it. Then through AASC Cloud (findViaCloud),
 * when the phone holds a backend token for it: the Mac at a Tailscale address its
 * owner's account lists, with `tailnet` moved to it. Either way the Mac there
 * proved it holds this phone's key over that address, and the row is saved once
 * the sign-in there works. Null: nowhere to look, nothing found, or the user
 * moved on. `triedTailnet`: the saved paths already tried the saved Tailscale
 * address (reachOrRescan: all of them failed), so the cloud need not name it
 * again; not when they stopped at a stranger on the home address, which never
 * got as far as the Tailscale one.
 */
async function search(
  deps: ShellDeps, mac: SavedMac, creds: MacCredentials, opts: OpenOptions, triedTailnet: boolean,
): Promise<Reached | null> {
  if (mac.status !== 'active') return null;
  const proceed = opts.proceed ?? (() => true);
  const hasCloud = (await readBackendCredential(deps.vault, mac.id).catch(() => null)) !== null;
  if (!mac.lanAllowed && !hasCloud) return null;
  opts.onSearch?.();
  if (mac.lanAllowed) {
    const lan = await rediscover(deps, mac, creds, proceed);
    if (!proceed()) return null;
    if (lan) return { mac: { ...mac, lan }, reached: { kind: 'lan', origin: `http://${lan}:${mac.port}`, encrypted: false } };
  }
  if (!hasCloud) return null;
  const host = await findViaCloud(deps, mac, creds, proceed, { triedTailnet });
  if (!host || !isTailnetAddress(host) || !proceed()) return null;
  return { mac: { ...mac, tailnet: host }, reached: { kind: 'tailnet', origin: `http://${host}:${mac.port}`, encrypted: true } };
}

/** The first saved path that answers; failing that, the search for the Mac (`search`). */
async function reachOrRescan(
  deps: ShellDeps, mac: SavedMac, onTry: ((c: Candidate) => void) | undefined, opts: OpenOptions,
): Promise<Reached | null> {
  const reached = await reach(deps, mac, onTry);
  if (reached) return { mac, reached };
  const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
  return creds ? search(deps, mac, creds, opts, true) : null;
}

/**
 * The saved home address answered, but as an AASC that doesn't know this key
 * (DEVICE_UNKNOWN, unverified): another Mac took the address. An approved
 * row's own Mac never forgets its key (a revoke keeps it: DEVICE_REVOKED), so
 * this isn't a removal; the phone looks for its Mac instead of wiping the row.
 */
function strangerAtSavedAddress(saved: SavedMac, found: Reached, session: SessionResult): boolean {
  return session.status === 'revoked' && !session.verified && found.mac === saved
    && found.reached.kind === 'lan' && saved.status === 'active';
}

/**
 * The Tailscale address to save for `mac`, out of what it just told this phone
 * (`fetchMacPaths` has checked its proof), or null to keep `mac.tailnet` as it is:
 * nothing proven, no address on that Mac (one that works is never erased:
 * Tailscale may only be off there for now), another port than this row's, an
 * address the connection plan could never build, or the address already saved.
 */
export function adoptTailnet(mac: SavedMac, paths: MacPaths | null): string | null {
  if (!paths || paths.tailnet === null || !isTailnetAddress(paths.tailnet)) return null;
  return paths.port === mac.port && paths.tailnet !== mac.tailnet ? paths.tailnet : null;
}

/**
 * Sign in on the first path that answers (or where the search found the
 * Mac, reachOrRescan), put the session in the WebView's
 * cookie and say where to go: `back` on that Mac (a path, from reauth), only
 * if the navigation guard allows it. A phone without its backend device for
 * this Mac asks for one first (backendLink.ts): quietly, within `linkMs`, and
 * again next time if it didn't work. A link still running after `linkMs` is cut
 * off and its late answer dropped, so it never writes outside this serialized turn.
 * At the same time it asks the Mac for its Tailscale address (fetchMacPaths, once,
 * within PATHS_BUDGET_MS) and saves one the Mac proved with this phone's key
 * (adoptTailnet): a phone paired before Tailscale was set up then reaches the
 * Mac from anywhere, without pairing again. Its late answer is dropped the same way.
 * Other rows for the same Mac (it was paired again) go before the page opens,
 * within `retireMs` and while `proceed()` holds (releasedTwins).
 */
export async function signInAndOpen(
  deps: ShellDeps, macs: readonly SavedMac[], saved: SavedMac, back: string, onTry?: (c: Candidate) => void,
  opts: OpenOptions = {},
): Promise<OpenOutcome> {
  const { linkMs = LINK_BUDGET_MS, retireMs = RETIRE_BUDGET_MS, proceed = () => true } = opts;
  let found = await reachOrRescan(deps, saved, onTry, opts);
  if (!found) return { kind: 'offline', mac: saved, tried: candidates(saved) };
  const creds = await readMacCredentials(deps.vault, saved.id).catch(() => null);
  if (!creds) {
    // The pairing key is gone (vault wiped, biometrics re-enrolled): this Mac must be paired again.
    return { kind: 'revoked', mac: saved, macs: await forgetMac(deps, macs, saved), why: 'key-missing' };
  }
  let session = await openSession(deps.http, found.reached.origin, creds);
  if (strangerAtSavedAddress(saved, found, session)) {
    found = await search(deps, saved, creds, opts, false);
    if (!found) return { kind: 'offline', mac: saved, tried: candidates(saved) };
    session = await openSession(deps.http, found.reached.origin, creds);
  }
  const { mac, reached } = found;
  switch (session.status) {
    case 'pending':
      return { kind: 'pending', mac };
    case 'revoked':
      return { kind: 'revoked', mac, macs: await forgetMac(deps, macs, saved), why: 'revoked' };
    case 'unreachable':
      return { kind: 'offline', mac: saved, tried: candidates(saved) };
    case 'error':
      return { kind: 'error', mac, message: session.message };
    case 'ok':
      break;
  }
  const url = returnUrl(reached.origin, back);
  if (!isAllowedNavigation(url, withMac(macs, { ...mac, status: 'active', lastPath: reached.kind }))) {
    return { kind: 'error', mac, message: 'This address isn’t one this phone paired with, so it wasn’t opened.' };
  }
  // A backend token the cloud refused to list Macs with (a 403, cloudFind) is replaced now, over this fresh session.
  const relink = await needsBackendRelink(deps.store, mac.id).catch(() => false);
  // Two separate questions to the same Mac, asked at once. The address is asked once per sign-in and never again after
  // a failure (each call without a valid session costs a login strike); it reaches the row only through adoptTailnet.
  const [backend, paths] = await Promise.all([
    within((signal) => linkBackend(deps, mac, reached.origin, session.token, signal, { relink }), linkMs, { kind: 'failed' } as const),
    within(() => fetchMacPaths(deps.requester, reached.origin, session.token, creds), PATHS_BUDGET_MS, null),
  ]);
  if (backend.kind === 'linked') await clearBackendRelink(deps.store, mac.id).catch(() => undefined); // a finished relink starts its cooldown
  const skip = await loadUnknownTwins(deps.store);
  const unknown: string[] = []; // read even when the budget cut the retire off: each entry was a strike spent
  const released = await within(
    (signal) => releasedTwins(deps, macs, mac, reached.origin, { pushSafe: backend.kind !== 'failed', skip, proceed, unknown }, signal),
    retireMs, [],
  );
  let kept: readonly SavedMac[] = macs;
  for (const twin of released) kept = await forgetMac(deps, kept, twin); // clears its cookies: before this one is set
  if (unknown.length) {
    await saveUnknownTwins(deps.store, [...skip, ...unknown].filter((k) => kept.some((m) => k.startsWith(`${m.id} `))));
  }
  // Signed in over the saved Tailscale address: it works, so it stays. (Another one named now would also take the
  // origin of the page about to open out of the WebView's allowed origins.)
  const learned = reached.kind === 'tailnet' ? null : adoptTailnet(mac, paths);
  const opened: SavedMac = {
    ...mac, status: 'active', confirmCode: null, lastPath: reached.kind, tailnet: learned ?? mac.tailnet,
    backendDeviceId: (backend.kind === 'linked' ? backend.macDeviceId : null) ?? mac.backendDeviceId ?? null,
  };
  const next = withMac(kept, opened);
  try {
    // Found at a new address (the home network moved, or the Mac named a new Tailscale address): the session at the
    // old one goes (the WebView may no longer load it anyway).
    if (mac.lan !== saved.lan && saved.lan) await deps.cookies.clear(`http://${saved.lan}:${saved.port}`).catch(() => undefined);
    if (opened.tailnet !== saved.tailnet && saved.tailnet) await deps.cookies.clear(`http://${saved.tailnet}:${saved.port}`).catch(() => undefined);
    await deps.cookies.set(reached.origin, session.token, SESSION_COOKIE_MAX_AGE);
    await deps.navigator.allowOrigins(allowedOrigins(next));
  } catch {
    return { kind: 'error', mac, message: 'The app couldn’t prepare the connection. Try again.', macs: released.length ? [...kept] : undefined };
  }
  await saveMacs(deps.store, next);
  await deps.store.set(LAST_MAC_KEY, opened.id);
  return { kind: 'navigate', url, mac: opened, macs: next, backendLinked: backend.kind === 'linked', retired: released.length > 0 };
}

const twinKey = (m: SavedMac, origin: string) => `${m.id} ${origin}`;

/**
 * This phone's other rows for the Mac that just signed `mac` in at `origin`,
 * which that Mac has let go. Only rows sharing a path with `mac` are asked
 * about, each by proving its key to the Mac (`openSession`), which is the only
 * sure test of "same Mac": a key it signs in or holds for approval is retired
 * as in unpairMac (push target first, then `unpairSelf`); one it checked and
 * had already revoked (`verified`) just goes. A key it doesn't know may be
 * another Mac's: that row stays, and since each such proof costs a login-limit
 * strike on the Mac (5 lock the phone out), it goes into the caller's `unknown`
 * (kept even if the budget cuts this off) and is never proved at that origin
 * again (`skip`); one such strike per sign-in at most, the rest wait for the
 * next. Returns the rows the Mac has let go, now or before, for the caller to
 * forget. A twin with push is left while the
 * opened row has none (`pushSafe` false: its link failed). Writes nothing on
 * the phone (the caller forgets the rows in its own turn) and stops at the next
 * step once `signal` aborts or `proceed()` fails; a row the Mac dropped as it
 * was cut off answers `verified` at the next sign-in.
 */
async function releasedTwins(
  deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac, origin: string,
  opts: { pushSafe: boolean; skip: readonly string[]; proceed: () => boolean; unknown: string[] }, signal: AbortSignal,
): Promise<SavedMac[]> {
  const go = () => !signal.aborted && opts.proceed();
  const twins = macs.filter((m) => m.id !== mac.id && !opts.skip.includes(twinKey(m, origin))
    && candidates({ ...m, lanAllowed: true }).some((c) => c.origin === origin));
  const released: SavedMac[] = [];
  for (const twin of twins) {
    if (!go() || opts.unknown.length > 0) break;
    const creds = await readMacCredentials(deps.vault, twin.id).catch(() => null);
    if (!creds) continue; // signInAndOpen forgets a keyless row when it is opened
    const known = await openSession(deps.http, origin, creds);
    if (known.status === 'revoked' && !known.verified) opts.unknown.push(twinKey(twin, origin));
    if (!go()) break;
    if (known.status === 'revoked' && known.verified) released.push(twin);
    if (known.status !== 'ok' && known.status !== 'pending') continue;
    const backend = await readBackendCredential(deps.vault, twin.id).catch(() => null);
    if (backend && !opts.pushSafe) continue;
    if (backend) await removePushTarget(deps.requester, backend);
    if (!go()) break;
    if (await unpairSelf(deps.http, origin, creds)) released.push(twin);
  }
  return released;
}

// ── Unpairing ────────────────────────────────────────────────────────────

/** Wipe a Mac from this phone: both tokens, its cookies, its relink record, its entry. */
export async function forgetMac(deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac): Promise<SavedMac[]> {
  await forgetCredentials(deps.vault, mac.id);
  await forgetBackendRelink(deps.store, mac.id).catch(() => undefined); // a record left behind is harmless; a failure here must not keep the Mac
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
