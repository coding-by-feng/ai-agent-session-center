// accountEnroll.ts — connect this phone to a Mac on its AASC Cloud account, without a QR (plan 17).
//
// The account vouches for the phone, never for an address (plan 17 rule 1). So:
//   1. Candidates: the Tailscale address the account lists for the Mac, then the `_aasc._tcp` services
//      Bonjour finds on this Wi-Fi at private addresses. Each is probed; only one that answers goes on.
//   2. At the first that answers: a fresh P-256 key pair, a 60 s single-use ticket from the backend bound
//      to (this phone, that Mac, this public key) and its seal secret (kept in memory only), then
//      POST <origin>/api/mobile/enroll with a fresh nonce.
//   3. Anything at an address may answer, so one candidate's refusal never ends the attempt (review fix
//      Correctness 1 / L1): NOT_THIS_MAC, ACCOUNT_ENROLL_OFF, REMOTE_PASSWORD_REQUIRED, a 403 or 429, an
//      unknown code, a PHONE_REVOKED the backend doesn't confirm, or a seal that doesn't open are remembered
//      and the next candidate gets the SAME ticket (a box never redeemed it). Only INVALID_TICKET stops: the
//      real Mac used or refused the ticket. If none accepts, the most specific remembered refusal is shown.
//   4. The Mac's answer opens only with the ticket's seal secret (a box that saw the phone's key can't seal
//      its own token to it, C1) and with the AAD naming the host:port THIS phone dialled (a relay passing
//      the request on gets a seal for the Mac's own address, which doesn't open here).
//   5. The device token goes to the vault, the Mac to the saved list as active with backendDeviceId = the
//      account's Mac device; the caller then opens it the normal way (signInAndOpen). The Mac drops an
//      account phone that opens no /session within 2 minutes, so if the user moved on during the save,
//      a session is opened here instead (nothing navigates).
// No ticket, token or key goes into an outcome, Preferences, a URL or a log.
import { listAccountMacs, type AccountMac } from './accountMacs.js';
import { readAccountCredential, signOutAccount } from './accountSignIn.js';
import type { Candidate } from './connectionPlan.js';
import { newEnrollNonce, newPhoneKey, openSealedCredentials, SEAL_SECRET, type PhoneKey } from './enrollCrypto.js';
import { errorCode, field, jsonHeaders } from './http.js';
import { BROWSE_BUDGET_MS, DISCOVERY_MS, whenCancelled, withinMs, type BrowseResult } from './lanRescan.js';
import type { ShellDeps } from './native.js';
import { openSession, unpairSelf, type HttpResponse } from './pairingClient.js';
import { isBackendHost, isPrivateLanAddress, isTailnetAddress } from './pairingLink.js';
import { saveMacs, withMac, writeMacCredentials, type SavedMac } from './savedMacs.js';
import { probeWith } from './shellFlows.js';

/** An owner has a handful of Macs on one Wi-Fi; this many addresses are tried at most. */
export const MAX_ENROLL_CANDIDATES = 8;
const B64U43 = /^[A-Za-z0-9_-]{43}$/;

export type EnrollOutcome =
  | { ok: true; mac: SavedMac; macs: SavedMac[] }
  | { ok: false; reason: 'signed-out' | 'unreachable' | 'refused' | 'invalid' | 'storage' | 'cancelled'; message: string };

export interface EnrollOptions {
  /** How the Mac lists this phone. */
  phoneName: string;
  /** False once the user has moved on: nothing more is asked or saved. */
  proceed?: () => boolean;
  /** The address it is trying now (the status line). */
  onTry?: (c: Candidate) => void;
  /** How long the Bonjour browse may take (BROWSE_BUDGET_MS). */
  browseBudgetMs?: number;
}

type EnrollDeps = Pick<ShellDeps, 'os' | 'vault' | 'store' | 'http' | 'requester' | 'newId' | 'discovery'>;
type Failure = Extract<EnrollOutcome, { ok: false }>;

const SAVED_NOTHING = 'Nothing was saved.';
const fail = (reason: Failure['reason'], message: string): Failure => ({ ok: false, reason, message });

/** What Bonjour found on this Wi-Fi, within the budget and until the user moves on; nothing without a browser. */
async function browse(deps: EnrollDeps, proceed: () => boolean, budgetMs: number): Promise<BrowseResult['services']> {
  if (!deps.discovery) return [];
  const cancelled = whenCancelled(proceed, null);
  try {
    const found = await Promise.race([withinMs(deps.discovery.browse(DISCOVERY_MS), budgetMs, null), cancelled.promise]);
    return Array.isArray(found?.services) ? found.services : [];
  } finally {
    cancelled.stop();
  }
}

/** The addresses to try, each once: the listed Tailscale address, then Bonjour's private ones (the listed port first). */
export function enrollCandidates(mac: AccountMac, services: BrowseResult['services']): Candidate[] {
  const out: Candidate[] = [];
  const add = (c: Candidate) => {
    if (!out.some((x) => x.origin === c.origin)) out.push(c);
  };
  if (mac.tailnet && isTailnetAddress(mac.tailnet) && mac.port !== null) {
    add({ kind: 'tailnet', origin: `http://${mac.tailnet}:${mac.port}`, encrypted: true });
  }
  const lan = services.filter((s) => typeof s?.host === 'string' && isPrivateLanAddress(s.host)
    && Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535);
  const ordered = [...lan.filter((s) => s.port === mac.port), ...lan.filter((s) => s.port !== mac.port)];
  for (const s of ordered) add({ kind: 'lan', origin: `http://${s.host}:${s.port}`, encrypted: false });
  return out.slice(0, MAX_ENROLL_CANDIDATES);
}

/** The port a URL dials: its own, or the scheme's default, which URL leaves out (`http://h:80` has port ''). */
export function dialledPort(url: URL): number {
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

type TicketResult = { ok: true; ticket: string; sealSecret: string } | Failure;

/** A ticket from the backend for (this phone, `mac`, `key`). */
async function askTicket(deps: EnrollDeps, mac: AccountMac, key: PhoneKey): Promise<TicketResult> {
  const cred = await readAccountCredential(deps.vault).catch(() => null);
  if (!cred || !isBackendHost(cred.host)) return fail('signed-out', 'Sign in to AASC Cloud again.');
  let res: HttpResponse;
  try {
    res = await deps.requester.request({
      method: 'POST', url: `https://${cred.host}/v1/enroll/tickets`, headers: jsonHeaders(cred.token),
      body: { macDeviceId: mac.deviceId, phoneKey: key.phoneKey },
    });
  } catch {
    return fail('refused', `AASC Cloud didn’t answer. Try again. ${SAVED_NOTHING}`);
  }
  // 401: the account token is dead. 403: it lacks macs:enroll, which only a new sign-in grants.
  if (res.status === 401 || res.status === 403) {
    await signOutAccount(deps);
    return fail('signed-out', 'AASC Cloud signed this phone out. Sign in again.');
  }
  if (res.status === 404) return fail('refused', `${mac.name} is no longer on your AASC Cloud account. ${SAVED_NOTHING}`);
  if (res.status === 429) return fail('refused', `Too many tries. Wait a minute, then try again. ${SAVED_NOTHING}`);
  const ticket = field(res.data, ['data', 'ticket']);
  const sealSecret = field(res.data, ['data', 'sealSecret']);
  if ((res.status !== 200 && res.status !== 201) || typeof ticket !== 'string' || !B64U43.test(ticket)
    || typeof sealSecret !== 'string' || !SEAL_SECRET.test(sealSecret)) {
    return fail('refused', `AASC Cloud didn’t answer. Try again. ${SAVED_NOTHING}`);
  }
  return { ok: true, ticket, sealSecret };
}

/**
 * A candidate's refusal, remembered while the next is tried. `rank`: how specific it is (the highest is shown if no
 * candidate accepts); `stop`: end the attempt now.
 */
interface Refusal {
  rank: number;
  failure: Failure;
  stop?: boolean;
}

const RANK = {
  notThisMac: 0, other: 1, rateLimited: 2, busy: 3, tooManyPhones: 4, cloud: 5, phoneRevoked: 6, password: 7, off: 8,
  invalidTicket: 9, badSeal: 10,
} as const;

/** What a candidate's non-201 answer means. PHONE_REVOKED is confirmed with the backend before it signs anyone out. */
async function refusal(deps: EnrollDeps, mac: AccountMac, res: HttpResponse): Promise<Refusal> {
  const refused = (rank: number, message: string, stop = false): Refusal => ({ rank, failure: fail('refused', `${message} ${SAVED_NOTHING}`), stop });
  switch (errorCode(res.data)) {
    case 'NOT_THIS_MAC':
      return { rank: RANK.notThisMac, failure: unreachable(mac) };
    case 'ACCOUNT_ENROLL_OFF':
      return refused(RANK.off, `${mac.name} doesn’t let account sign-ins connect. Turn that on in its devices panel, or pair with a QR code.`);
    case 'REMOTE_PASSWORD_REQUIRED':
      return refused(RANK.password, `${mac.name} needs a dashboard password before phones can connect.`);
    case 'INVALID_TICKET':
      return refused(RANK.invalidTicket, `${mac.name} refused the sign-in. Try again.`, true);
    case 'ENROLL_BUSY': // 429: another enroll from this address is in flight
      return refused(RANK.busy, `${mac.name} is busy connecting another phone. Try again in a few seconds.`);
    case 'TOO_MANY_NEW_PHONES': // 429: the Mac holds too many unconfirmed account phones
      return refused(RANK.tooManyPhones, `${mac.name} has too many phones waiting to connect. Try again in a couple of minutes.`);
    case 'CLOUD_UNAVAILABLE':
      return refused(RANK.cloud, `${mac.name} couldn’t reach AASC Cloud. Try again in a moment.`);
    case 'PHONE_REVOKED': {
      // Anything on the LAN can say this; only the backend can sign this phone out (a 401 there forgets the account).
      const confirmed = await listAccountMacs(deps).catch(() => null);
      if (confirmed?.status === 'signed-out') {
        return { rank: RANK.phoneRevoked, failure: fail('signed-out', 'This phone was removed from your AASC Cloud account. Sign in again.'), stop: true };
      }
      // The account is fine: the Mac's own deny list (its user removed this phone there).
      if (confirmed?.status === 'ok') return refused(RANK.phoneRevoked, `${mac.name} removed this phone.`);
      return refused(RANK.phoneRevoked, `${mac.name} refused this phone. Try again, or sign in to AASC Cloud again.`);
    }
    default:
      if (res.status === 429) return refused(RANK.rateLimited, 'Too many tries. Wait a minute, then try again.');
      return refused(RANK.other, `Connecting to ${mac.name} failed (${res.status}).`);
  }
}

const unreachable = (mac: AccountMac): Failure => fail(
  'unreachable', `Can’t reach ${mac.name}. Be on its Wi-Fi or sign both in to Tailscale, and check AASC is running there. ${SAVED_NOTHING}`,
);

/** The Mac saved and its key in the vault; a vault that won't store takes this phone off the Mac again. */
async function save(
  deps: EnrollDeps, macs: readonly SavedMac[], mac: AccountMac, reached: Candidate, creds: { deviceId: string; deviceToken: string },
  phoneName: string,
): Promise<EnrollOutcome> {
  const url = new URL(reached.origin);
  const hostname = url.hostname;
  const saved: SavedMac = {
    id: deps.newId(), name: mac.name, port: dialledPort(url), lan: reached.kind === 'lan' ? hostname : null,
    tailnet: reached.kind === 'tailnet' ? hostname : null, lanAllowed: reached.kind === 'lan', backendDeviceId: mac.deviceId,
    status: 'active', confirmCode: null, phoneName, lastPath: reached.kind, unconfirmed: true,
  };
  try {
    await writeMacCredentials(deps.vault, saved.id, creds);
  } catch {
    await unpairSelf(deps.http, reached.origin, creds); // don't leave a phone on the Mac that can't sign in
    return fail('storage', 'This phone couldn’t store the key securely, so nothing was saved.');
  }
  const next = withMac(macs, saved);
  await saveMacs(deps.store, next);
  return { ok: true, mac: saved, macs: next };
}

/** A session on the Mac without opening it; once it signs in, the row is an ordinary one (no `unconfirmed`). */
async function confirmInBackground(
  deps: EnrollDeps, out: Extract<EnrollOutcome, { ok: true }>, origin: string, creds: { deviceId: string; deviceToken: string },
): Promise<EnrollOutcome> {
  const session = await openSession(deps.http, origin, creds).catch(() => null);
  if (session?.status !== 'ok') return out;
  const { unconfirmed: _done, ...mac } = out.mac;
  const next = withMac(out.macs, mac);
  try {
    await saveMacs(deps.store, next);
  } catch {
    return out;
  }
  return { ok: true, mac, macs: next };
}

export async function enrollViaAccount(
  deps: EnrollDeps, macs: readonly SavedMac[], mac: AccountMac, opts: EnrollOptions,
): Promise<EnrollOutcome> {
  const proceed = opts.proceed ?? (() => true);
  const cancelled = fail('cancelled', `Cancelled. ${SAVED_NOTHING}`);
  if (!(await readAccountCredential(deps.vault).catch(() => null))) return fail('signed-out', 'Sign in to AASC Cloud first.');
  if (!proceed()) return cancelled;
  const tried = enrollCandidates(mac, await browse(deps, proceed, opts.browseBudgetMs ?? BROWSE_BUDGET_MS));
  if (!proceed()) return cancelled;
  // Every candidate at once; then in order, the ones that answered.
  const probe = probeWith(deps);
  const answers = tried.map((c) => probe(c.origin));
  let session: { key: PhoneKey; ticket: string; sealSecret: string } | null = null;
  let best: Refusal | null = null;
  const remember = (r: Refusal) => {
    if (!best || r.rank > best.rank) best = r;
  };
  for (const [i, c] of tried.entries()) {
    if (!(await answers[i]) || !proceed()) continue;
    opts.onTry?.(c);
    if (!session) {
      const key = await newPhoneKey();
      const ticket = await askTicket(deps, mac, key);
      if (!ticket.ok) return ticket;
      session = { key, ticket: ticket.ticket, sealSecret: ticket.sealSecret };
    }
    if (!proceed()) return cancelled;
    const nonce = newEnrollNonce();
    let res: HttpResponse;
    try {
      res = await deps.http.post(`${c.origin}/api/mobile/enroll`, {
        macDeviceId: mac.deviceId, ticket: session.ticket, phoneKey: session.key.phoneKey, nonce,
        label: opts.phoneName, platform: deps.os === 'ios' ? 'ios' : 'android',
      });
    } catch {
      continue; // gone since the probe: the next address
    }
    if (res.status !== 201) {
      const r = await refusal(deps, mac, res);
      if (r.stop) return (best && (best as Refusal).rank > r.rank ? (best as Refusal) : r).failure;
      remember(r);
      continue;
    }
    const url = new URL(c.origin);
    const creds = await openSealedCredentials(session.key, field(res.data, ['data']), nonce, url.hostname, dialledPort(url), session.sealSecret);
    if (!creds) {
      // A box sealing its own token, or a relay (whose Mac then holds a used ticket: the next real answer stops).
      remember({ rank: RANK.badSeal, failure: fail('invalid', `${mac.name}’s answer didn’t check out for the address this phone reached, so nothing was saved.`) });
      continue;
    }
    if (!proceed()) {
      await unpairSelf(deps.http, c.origin, creds);
      return cancelled;
    }
    const out = await save(deps, macs, mac, c, creds, opts.phoneName);
    // Saved, but the user left meanwhile, so the caller won't open it: confirm the row with a session now.
    if (out.ok && !proceed()) return confirmInBackground(deps, out, c.origin, creds);
    return out;
  }
  if (!proceed()) return cancelled;
  return (best as Refusal | null)?.failure ?? unreachable(mac);
}
