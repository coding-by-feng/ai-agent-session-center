// fakeAccount.ts — the pretend AASC Cloud account a phone signs in to (plan 17), for dev builds and tests.
//
// Answers what aasc-backend answers for a phone that signs in with Google: the start URL's redirect
// (googleRedirect: a one-use code bound to the PKCE challenge), POST /v1/devices/pair with the
// verifier, GET /v1/enroll/macs and POST /v1/enroll/tickets (Bearer, the phone's account token),
// with the same status codes and envelope ({ success, data } / { success: false, error: { code } }).
// The Mac's side of a ticket (POST /v1/enroll/tickets/redeem) is `redeem`, which fakeMac.ts calls
// in-process. Never bundled into a release build: only fakeMac.ts imports it.
import { b64urlDecode, b64urlEncode, randomB64url } from '../enrollCrypto.js';
import type { HttpMethod } from '../http.js';
import type { HttpResponse } from '../pairingClient.js';

export interface FakeAccountMac {
  deviceId: string;
  name: string;
  tailnet: string | null;
  port: number | null;
  lastUsedAt?: string | null;
}

export interface FakeAccountOptions {
  /** The owner's Google address, answered with the pairing; null: an owner without one. */
  email?: string | null;
  /** What GET /v1/enroll/macs lists (the owner's Macs that can enroll a phone). */
  macs?: readonly FakeAccountMac[];
}

/** The phone return URLs the backend accepts (exact match). */
const PHONE_RETURNS = ['work.aasc.mobile://auth/google', 'https://aasc.work/auth/google'];
const B64U43 = /^[A-Za-z0-9_-]{43}$/;
const PHONE_KEY = /^[A-Za-z0-9_-]{87}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_TTL_MS = 60_000;

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
     * code (bound to `c`) and the state `s`. Null for a start URL the backend would refuse.
     */
    googleRedirect(startUrl: string): string | null {
      const url = new URL(startUrl);
      const back = url.searchParams.get('return') ?? '';
      const c = url.searchParams.get('c') ?? '';
      const s = url.searchParams.get('s') ?? '';
      if (url.protocol !== 'https:' || url.host !== host || url.pathname !== '/v1/auth/google/start') return null;
      if (!PHONE_RETURNS.includes(back) || !B64U43.test(c) || !s) return null;
      const code = issue(randomB64url(16));
      codes.set(code, c);
      return `${back}?${new URLSearchParams({ code, state: s })}`;
    },
    /** The account routes; null for any other path (the caller's backend answers those). */
    async route(path: string, method: HttpMethod, headers: Record<string, string>, body: Record<string, unknown>): Promise<HttpResponse | null> {
      if (method === 'POST' && path === '/v1/devices/pair' && codes.has(String(body.code ?? ''))) return pair(body);
      if (!path.startsWith('/v1/enroll/')) return null;
      const device = deviceOf(headers);
      if (!device) return refuse(401, 'unauthorized');
      if (method === 'GET' && path === '/v1/enroll/macs') {
        return ok(200, { success: true, data: { macs: macs.map((m) => ({ lastUsedAt: null, ...m })) } });
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
  };
}

export type FakeAccount = ReturnType<typeof createFakeAccount>;
