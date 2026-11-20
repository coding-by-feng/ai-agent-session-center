// fakeAccount.ts — the pretend AASC Cloud account a phone signs in to (plan 17), for dev builds and tests.
//
// Answers what aasc-backend answers for a phone that signs in with Google: the start URL's redirect
// (googleRedirect: a one-use code bound to the PKCE challenge), POST /v1/devices/pair with the
// verifier, GET /v1/enroll/macs and POST /v1/enroll/tickets (Bearer, the phone's account token),
// with the same status codes and envelope ({ success, data } / { success: false, error: { code } }).
// Plan 18: GET /v1/machines, the directory of the account's computers (the same Macs, with the
// home-network address too): 401 for an unknown token, then 404 from a backend without it, then 403
// for a phone that signed in before it existed (`directory`).
// The Mac's side of a ticket (POST /v1/enroll/tickets/redeem) is `redeem`, which fakeMac.ts calls
// in-process. A start URL with intent=delete (Nov 20 2026) ends on the backend's "Delete your AASC Cloud
// account?" page instead: its one button deletes the account the person signed in to the sheet with, and
// the return carries `deleted=1` and the state, never a code. Never bundled into a release build: only
// fakeMac.ts imports it.
import { b64urlDecode, b64urlEncode, randomB64url } from '../enrollCrypto.js';
import type { HttpMethod } from '../http.js';
import type { HttpResponse } from '../pairingClient.js';

export interface FakeAccountMac {
  deviceId: string;
  name: string;
  tailnet: string | null;
  port: number | null;
  lastUsedAt?: string | null;
  /** Plan 18, GET /v1/machines only: the home-network and public addresses the Mac publishes (default none). */
  lan?: string | null;
  public?: string | null;
  /** GET /v1/machines only: can it redeem a ticket (default true), and how the account relates to it (default 'self'). */
  connectable?: boolean;
  relation?: string;
}

/**
 * How GET /v1/machines answers a signed-in phone. `listed`: the directory. `forbidden`: 403, a phone that signed
 * in before the backend listed computers (its token has no machines:read). `absent`: 404, a backend without it.
 */
export type FakeDirectory = 'listed' | 'forbidden' | 'absent';

export interface FakeAccountOptions {
  /** The owner's Google address, answered with the pairing; null: an owner without one. */
  email?: string | null;
  /** What GET /v1/enroll/macs lists (the owner's Macs that can enroll a phone), and GET /v1/machines with more. */
  macs?: readonly FakeAccountMac[];
  /** Plan 18: how GET /v1/machines answers (default `listed`). */
  directory?: FakeDirectory;
  /**
   * The Google account the person picks in a sheet opened with intent=delete. `'this'` (default): this account,
   * which "Delete my account" then deletes. `'another'`: some other account goes and this one stays.
   */
  deletes?: 'this' | 'another';
}

/** What the person does in the sign-in sheet (a delete only: a sign-in always goes through). */
export interface FakeSheet {
  /** False: the address "Delete my account" would return to, with nothing deleted. Default true. */
  pressDelete?: boolean;
}

/** The phone return URLs the backend accepts (exact match). */
const PHONE_RETURNS = ['work.aasc.mobile://auth/google', 'https://aasc.work/auth/google'];
const B64U43 = /^[A-Za-z0-9_-]{43}$/;
const PHONE_KEY = /^[A-Za-z0-9_-]{87}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_TTL_MS = 60_000;
/** When the fake's Macs last published their addresses. */
const PATHS_UPDATED_AT = '2026-10-21T00:00:00.000Z';

export type RedeemResult =
  | { ok: true; phoneDeviceId: string; phoneKeyHash: string; email: string | null; sealSecret: string }
  | { ok: false; why: 'invalid' | 'expired' | 'used' | 'phone-revoked' };

interface Ticket {
  phoneDeviceId: string;
  macDeviceId: string;
  phoneKeyHash: string;
  /** Plan 17 C1: given to the phone with the ticket and to the redeeming Mac only. */
  sealSecret: string;
  expiresAt: number;
  redeemed: boolean;
}

const ok = (status: number, data: unknown): HttpResponse => ({ status, data });
const refuse = (status: number, code: string): HttpResponse => ok(status, { success: false, error: { code } });

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A Mac as GET /v1/enroll/macs lists it: the Tailscale address only. */
function enrollEntry(m: FakeAccountMac) {
  return { deviceId: m.deviceId, name: m.name, tailnet: m.tailnet, port: m.port, lastUsedAt: m.lastUsedAt ?? null };
}

/** A Mac as GET /v1/machines lists it; `paths` is null while it publishes nothing (the backend: no port on record). */
function machineEntry(m: FakeAccountMac) {
  return {
    deviceId: m.deviceId, name: m.name, platform: 'macos', edition: 'full', appVersion: '2.10.80', lastUsedAt: m.lastUsedAt ?? null,
    current: false, connectable: m.connectable ?? true, relation: m.relation ?? 'self',
    paths: m.port === null
      ? null
      : { lan: m.lan ?? null, tailnet: m.tailnet, public: m.public ?? null, port: m.port, updatedAt: PATHS_UPDATED_AT },
  };
}

export function createFakeAccount(host: string, opts: FakeAccountOptions, issue: (secret: string) => string) {
  const email = opts.email === undefined ? 'owner@example.com' : opts.email;
  const macs: FakeAccountMac[] = [...(opts.macs ?? [])];
  /** Google codes minted by the start URL, each with its PKCE challenge. */
  const codes = new Map<string, string>();
  /** The phone's account devices: token → device id. */
  const devices = new Map<string, string>();
  const revoked = new Set<string>();
  const tickets = new Map<string, Ticket>();
  const ticketCalls: Array<{ macDeviceId: unknown; phoneKey: unknown }> = [];
  let deleted = false;
  let directory: FakeDirectory = opts.directory ?? 'listed';

  /** As the backend's deleteOwner: none of the owner's devices is known any more; its codes, tickets and Macs go. */
  function deleteOwner(): void {
    deleted = true;
    for (const id of devices.values()) revoked.add(id);
    codes.clear();
    tickets.clear();
    macs.splice(0, macs.length);
  }

  function deviceOf(headers: Record<string, string>): string | null {
    const id = devices.get((headers.Authorization ?? '').replace(/^Bearer /, ''));
    return id && !revoked.has(id) ? id : null;
  }

  async function pair(body: Record<string, unknown>): Promise<HttpResponse> {
    const code = String(body.code ?? '');
    const challenge = codes.get(code);
    codes.delete(code); // single use, whatever the verifier
    if (typeof body.verifier !== 'string' || b64urlEncode(await sha256(new TextEncoder().encode(body.verifier))) !== challenge) {
      return refuse(401, 'invalid_pairing_code');
    }
    const deviceId = `acct-${randomB64url(6)}`;
    const token = issue(randomB64url(32));
    devices.set(token, deviceId);
    return ok(201, { success: true, data: { ownerId: 'owner-1', deviceId, token, account: email === null ? null : { email } } });
  }

  async function newTicket(phoneDeviceId: string, body: Record<string, unknown>): Promise<HttpResponse> {
    ticketCalls.push({ macDeviceId: body.macDeviceId, phoneKey: body.phoneKey });
    if (Object.keys(body).length !== 2 || typeof body.phoneKey !== 'string' || !PHONE_KEY.test(body.phoneKey)
      || typeof body.macDeviceId !== 'string' || !UUID.test(body.macDeviceId)) return refuse(400, 'invalid_input');
    if (!macs.some((m) => m.deviceId === body.macDeviceId)) return refuse(404, 'mac_not_found');
    const ticket = issue(randomB64url(32));
    const sealSecret = issue(randomB64url(32));
    tickets.set(ticket, {
      phoneDeviceId, macDeviceId: String(body.macDeviceId), expiresAt: Date.now() + TICKET_TTL_MS, redeemed: false,
      phoneKeyHash: hex(await sha256(b64urlDecode(body.phoneKey)!)), sealSecret,
    });
    return ok(200, { success: true, data: { ticket, sealSecret, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() } });
  }

  return {
    /**
     * Where the backend sends the sign-in sheet after Google: the start URL's return URL with a one-use
     * code (bound to `c`) and the state `s`. Null for a start URL the backend would refuse. With
     * intent=delete: the return URL with `deleted=1` and the state, once the person pressed "Delete my
     * account" (`sheet.pressDelete`), which deletes this account unless they picked another (`opts.deletes`).
     */
    googleRedirect(startUrl: string, sheet: FakeSheet = {}): string | null {
      const url = new URL(startUrl);
      const back = url.searchParams.get('return') ?? '';
      const c = url.searchParams.get('c') ?? '';
      const s = url.searchParams.get('s') ?? '';
      const intent = url.searchParams.get('intent');
      if (url.protocol !== 'https:' || url.host !== host || url.pathname !== '/v1/auth/google/start') return null;
      if (!PHONE_RETURNS.includes(back) || !B64U43.test(c) || !s) return null;
      if (intent !== null && intent !== 'delete') return null;
      if (intent === 'delete') {
        if (sheet.pressDelete !== false && opts.deletes !== 'another') deleteOwner();
        return `${back}?${new URLSearchParams({ deleted: '1', state: s })}`;
      }
      const code = issue(randomB64url(16));
      codes.set(code, c);
      return `${back}?${new URLSearchParams({ code, state: s })}`;
    },
    /** The account routes; null for any other path (the caller's backend answers those). */
    async route(path: string, method: HttpMethod, headers: Record<string, string>, body: Record<string, unknown>): Promise<HttpResponse | null> {
      if (method === 'POST' && path === '/v1/devices/pair' && codes.has(String(body.code ?? ''))) return pair(body);
      const machines = method === 'GET' && path === '/v1/machines';
      if (!machines && !path.startsWith('/v1/enroll/')) return null;
      const device = deviceOf(headers);
      if (!device) return refuse(401, 'unauthorized');
      if (machines) {
        if (directory === 'absent') return refuse(404, 'not_found');
        if (directory === 'forbidden') return refuse(403, 'forbidden');
        return ok(200, { success: true, data: { machines: macs.map(machineEntry) } });
      }
      if (method === 'GET' && path === '/v1/enroll/macs') {
        return ok(200, { success: true, data: { macs: macs.map(enrollEntry) } });
      }
      if (method === 'POST' && path === '/v1/enroll/tickets') return newTicket(device, body);
      return refuse(404, 'not_found');
    },
    /** POST /v1/enroll/tickets/redeem as the Mac `callerMacDeviceId` calls it. */
    redeem(ticket: unknown, callerMacDeviceId: string): RedeemResult {
      const t = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
      if (!t || t.macDeviceId !== callerMacDeviceId) return { ok: false, why: 'invalid' };
      if (Date.now() >= t.expiresAt) return { ok: false, why: 'expired' };
      if (t.redeemed) return { ok: false, why: 'used' };
      if (revoked.has(t.phoneDeviceId)) return { ok: false, why: 'phone-revoked' };
      t.redeemed = true;
      return { ok: true, phoneDeviceId: t.phoneDeviceId, phoneKeyHash: t.phoneKeyHash, email, sealSecret: t.sealSecret };
    },
    /** The phone's account devices so far (ids). */
    devices: () => [...devices.values()],
    /** Has "Delete my account" deleted this account? */
    deleted: () => deleted,
    /** As the backend's revokeDevices: the phone's tickets go with it (a later redeem is ticket_invalid). */
    revokeDevice(deviceId: string) {
      revoked.add(deviceId);
      for (const [ticket, t] of tickets) if (t.phoneDeviceId === deviceId) tickets.delete(ticket);
    },
    /** Every POST /v1/enroll/tickets body (without the answer). */
    ticketCalls,
    /** Tickets the backend issued, and whether each was redeemed. */
    tickets: () => [...tickets.values()].map((t) => ({ macDeviceId: t.macDeviceId, redeemed: t.redeemed })),
    setMacs(next: readonly FakeAccountMac[]) {
      macs.splice(0, macs.length, ...next);
    },
    /** GET /v1/machines answers this way from now on (`listed`: the phone signed in again, or the backend was updated). */
    setDirectory(next: FakeDirectory) {
      directory = next;
    },
  };
}

export type FakeAccount = ReturnType<typeof createFakeAccount>;
