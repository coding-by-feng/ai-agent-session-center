// notificationTap.ts — a notification tap → which Mac, which session, which tab (AASC-19).
//
// The Mac UI opens `/?session=<id>&tab=terminal|conversation` itself
// (src/hooks/useSessionDeepLink.ts) and silently ignores an id it can't see, so
// the shell checks first: it signs in on the Mac, lists the sessions this phone
// may see and only then deep-links. A session that ended or is no longer shared
// lands on LIVE with a message. Hidden and unknown look the same, on purpose.
//
// Which Mac: the payload doesn't name one yet (README "Decisions"). Until it
// does, the order is: the Mac the session was last seen on, the only paired Mac,
// the Mac used last, then the others (at most MAX_TRIED Macs per tap).
//
// Runs after the biometric gate: a tap from a locked app waits for the unlock
// (biometricLock.ts), so the shell marks the tap in flight only once it starts here.
import { candidates, pickReachable, type PairedServer } from './connectionPlan.js';
import type { SessionResult } from './pairingClient.js';
import type { PushArrival, PushKind } from './pushPayload.js';
import { returnUrl } from './reauth.js';
import type { SessionsResult } from './sessions.js';

export type DeepLinkTab = 'terminal' | 'conversation';

const MAX_TRIED = 3;
/** Session → Mac hints kept; older ones are dropped first. */
const MAX_OWNERS = 500;

/** Approval and input open the terminal (where the prompt is); finished and interrupted the conversation. */
export function tabForKind(kind: PushKind): DeepLinkTab | null {
  if (kind === 'approval' || kind === 'input') return 'terminal';
  if (kind === 'finished' || kind === 'interrupted') return 'conversation';
  return null;
}

/** The path src/lib/deepLink.ts parses. */
export function deepLinkPath(sessionRef: string, tab: DeepLinkTab): string {
  return `/?session=${encodeURIComponent(sessionRef)}&tab=${tab}`;
}

/**
 * [sessionRef, serverId] pairs from the session lists the shell saw, oldest
 * first. A list, not an object: object keys that look like numbers reorder.
 * Persisted in Preferences (session ids only, nothing secret).
 */
export type SessionOwners = ReadonlyArray<readonly [string, string]>;

export interface TapHints {
  /** The Mac the WebView showed last. */
  lastServerId: string | null;
  sessionOwners: SessionOwners;
}

/** This Mac's current list replaces what was recorded for it (ended sessions drop out); bounded. */
export function rememberOwners(owners: SessionOwners, serverId: string, sessionIds: readonly string[]): SessionOwners {
  const fresh = new Set(sessionIds);
  const kept = owners.filter(([ref, owner]) => owner !== serverId && !fresh.has(ref));
  const next = [...kept, ...[...fresh].map((id) => [id, serverId] as const)];
  return next.slice(Math.max(0, next.length - MAX_OWNERS));
}

/** The Mac a session was last seen on, or null. */
export function ownerOf(owners: SessionOwners, sessionRef: string): string | null {
  for (let i = owners.length - 1; i >= 0; i--) {
    if (owners[i][0] === sessionRef) return owners[i][1];
  }
  return null;
}

/** The Macs to try, most likely first. */
export function tapServerOrder(arrival: PushArrival, servers: readonly PairedServer[], hints: TapHints): PairedServer[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const named = arrival.macRef ? byId.get(arrival.macRef) : undefined;
  if (named) return [named]; // the payload said which Mac: never guess another
  const order: PairedServer[] = [];
  const add = (s: PairedServer | undefined) => {
    if (s && !order.includes(s)) order.push(s);
  };
  add(byId.get(ownerOf(hints.sessionOwners, arrival.sessionRef) ?? ''));
  add(byId.get(hints.lastServerId ?? ''));
  servers.forEach(add);
  return order.slice(0, MAX_TRIED);
}

export type TapOutcome =
  | { action: 'navigate'; serverId: string; url: string; message: string | null }
  | { action: 'shell'; screen: 'home' | 'offline' | 'approve-wait' | 'pair'; message: string; retry: boolean };

export interface TapDeps {
  servers: readonly PairedServer[];
  hints: TapHints;
  /** connectionPlan's probe (GET /api/auth/status within 3 s). */
  probe(origin: string): Promise<boolean>;
  /** openSession + set the WebView cookie for `origin`. */
  signIn(server: PairedServer, origin: string): Promise<SessionResult>;
  /** sessions.listSessions with the token signIn obtained (the shell keeps it). */
  listSessions(server: PairedServer, origin: string): Promise<SessionsResult>;
}

export const SESSION_GONE_MESSAGE = "That session isn't available any more: it ended or is no longer shared with this phone.";

export async function openFromTap(arrival: PushArrival, deps: TapDeps): Promise<TapOutcome> {
  const order = tapServerOrder(arrival, deps.servers, deps.hints);
  if (order.length === 0) {
    return { action: 'shell', screen: 'home', message: 'That Mac is no longer paired with this phone.', retry: false };
  }
  const tab = tabForKind(arrival.kind);
  let missingOn: { server: PairedServer; origin: string } | null = null;
  let pending: PairedServer | null = null;
  let revoked: PairedServer | null = null;
  /** The first Mac whose sessions couldn't be checked, and why. */
  let unchecked: { server: PairedServer; why: string } | null = null;

  for (const server of order) {
    const reached = await pickReachable(candidates(server), deps.probe);
    if (!reached) {
      unchecked ??= { server, why: "couldn't be reached" };
      continue;
    }
    const session = await deps.signIn(server, reached.origin);
    if (session.status === 'pending') pending ??= server;
    if (session.status === 'revoked') revoked ??= server;
    if (session.status !== 'ok') {
      unchecked ??= { server, why: session.status === 'pending' ? 'is waiting for you to approve this phone' : session.status === 'revoked' ? 'removed this phone' : "couldn't be reached" };
      continue;
    }
    if (!tab) return { action: 'navigate', serverId: server.id, url: returnUrl(reached.origin, '/'), message: null };
    const listed = await deps.listSessions(server, reached.origin);
    const deepLink = returnUrl(reached.origin, deepLinkPath(arrival.sessionRef, tab));
    // Can't confirm: let the Mac UI decide (it ignores an id it can't see).
    if (listed.status !== 'ok') return { action: 'navigate', serverId: server.id, url: deepLink, message: null };
    if (listed.sessions.some((s) => s.sessionId === arrival.sessionRef)) {
      return { action: 'navigate', serverId: server.id, url: deepLink, message: null };
    }
    missingOn ??= { server, origin: reached.origin };
  }

  if (missingOn) {
    // Not "gone" when the Mac that probably has it was never checked.
    const message = unchecked
      ? `That session isn't on ${missingOn.server.name}, and ${unchecked.server.name} ${unchecked.why}, so it couldn't be checked.`
      : SESSION_GONE_MESSAGE;
    return { action: 'navigate', serverId: missingOn.server.id, url: returnUrl(missingOn.origin, '/'), message };
  }
  if (pending) {
    return { action: 'shell', screen: 'approve-wait', message: `Approve this phone on ${pending.name} first.`, retry: true };
  }
  if (revoked) {
    return { action: 'shell', screen: 'pair', message: `${revoked.name} removed this phone. Pair again to open its sessions.`, retry: false };
  }
  const name = order.length === 1 ? order[0].name : 'your Mac';
  return { action: 'shell', screen: 'offline', message: `Can't reach ${name}. Check Tailscale or your home network.`, retry: true };
}
