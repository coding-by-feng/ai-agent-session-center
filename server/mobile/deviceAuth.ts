// deviceAuth.ts — pairing phones with this Mac (AASC-15).
//
// Flow: the desktop asks for a one-time pairing code (shown as a QR). The phone
// redeems it and receives a device token at once, but the device is PENDING:
// its token can't open a session until someone approves it on the desktop,
// comparing a 6-digit confirmation code shown on both screens. An approved phone
// exchanges its device token for the normal one-hour session (authManager), so
// it survives server restarts without ever knowing the dashboard password.
//
// Pure logic over an injected store and clock, so it is testable without SQLite.

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';

export type DevicePlatform = 'ios' | 'android';
export type DeviceStatus = 'pending' | 'active' | 'revoked';

export interface MobileDeviceRecord {
  id: string;
  label: string;
  platform: DevicePlatform;
  tokenHash: string;
  status: DeviceStatus;
  confirmCode: string;
  /** Non-secret reference to the backend pairing code this phone used, when there was one. */
  beCodeRef: string | null;
  createdAt: number;
  approvedAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

/** What the desktop may see. Never a hash or a token. */
export interface MobileDeviceView {
  id: string;
  label: string;
  platform: DevicePlatform;
  status: DeviceStatus;
  /** Only while pending: the code the phone also shows, for the approval check. */
  confirmCode: string | null;
  createdAt: number;
  approvedAt: number | null;
  lastSeenAt: number | null;
}

export interface MobileDeviceStore {
  insert(rec: MobileDeviceRecord): void;
  get(id: string): MobileDeviceRecord | null;
  update(id: string, patch: Partial<Pick<MobileDeviceRecord, 'status' | 'approvedAt' | 'lastSeenAt' | 'revokedAt'>>): void;
  /** Pending and active devices (revoked ones are kept but not listed). */
  listLive(): MobileDeviceRecord[];
  remove(id: string): void;
}

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;
export const MAX_OUTSTANDING_CODES = 3;
/** A phone nobody approves within this window is revoked. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** Base32 without I, O, 0 and 1, which read alike. 10 characters ≈ 50 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const MAX_LABEL = 80;

export type ExchangeResult =
  | { ok: true; device: MobileDeviceRecord }
  | { ok: false; reason: 'invalid' | 'pending' | 'revoked' };

export interface DeviceAuthOptions {
  store: MobileDeviceStore;
  now?: () => number;
  /** Called once when a device stops being usable (deny, revoke, unpair, pending expiry). */
  onRevoked?: (device: MobileDeviceRecord) => void;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function sanitizeDeviceLabel(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return cleaned || 'Phone';
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function toView(rec: MobileDeviceRecord): MobileDeviceView {
  return {
    id: rec.id,
    label: rec.label,
    platform: rec.platform,
    status: rec.status,
    confirmCode: rec.status === 'pending' ? rec.confirmCode : null,
    createdAt: rec.createdAt,
    approvedAt: rec.approvedAt,
    lastSeenAt: rec.lastSeenAt,
  };
}

export class TooManyPairingCodesError extends Error {
  constructor() {
    super(`At most ${MAX_OUTSTANDING_CODES} pairing codes can be open at once`);
  }
}

export function createDeviceAuth(opts: DeviceAuthOptions) {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  /** Open pairing codes, keyed by their hash. In memory on purpose: they live two minutes. */
  const codes = new Map<string, { expiresAt: number }>();

  function pruneCodes(): void {
    const t = now();
    for (const [hash, entry] of codes) if (entry.expiresAt <= t) codes.delete(hash);
  }

  function revokeRecord(rec: MobileDeviceRecord): void {
    if (rec.status === 'revoked') return;
    store.update(rec.id, { status: 'revoked', revokedAt: now() });
    opts.onRevoked?.({ ...rec, status: 'revoked', revokedAt: now() });
  }

  /** Pending devices nobody approved in time stop being approvable. */
  function expirePending(): void {
    const cutoff = now() - PENDING_TTL_MS;
    for (const rec of store.listLive()) {
      if (rec.status === 'pending' && rec.createdAt <= cutoff) revokeRecord(rec);
    }
  }

  function findByToken(deviceId: string, deviceToken: string): MobileDeviceRecord | null {
    const rec = store.get(deviceId);
    if (!rec) return null;
    return sameHash(rec.tokenHash, hashSecret(deviceToken)) ? rec : null;
  }

  return {
    createPairingCode(): { code: string; expiresAt: number } {
      pruneCodes();
      if (codes.size >= MAX_OUTSTANDING_CODES) throw new TooManyPairingCodesError();
      const code = newPairingCode();
      const expiresAt = now() + PAIRING_CODE_TTL_MS;
      codes.set(hashSecret(code), { expiresAt });
      return { code, expiresAt };
    },

    /** Redeem a pairing code. The device comes back pending, with its token shown this once. */
    redeem(input: { code: string; label: string; platform: DevicePlatform; beCodeRef?: string | null }):
      { device: MobileDeviceRecord; deviceToken: string } | null {
      pruneCodes();
      const hash = hashSecret(normalizePairingCode(input.code));
      if (!codes.has(hash)) return null;
      codes.delete(hash); // single use, even if the rest fails
      const deviceToken = randomBytes(32).toString('base64url');
      const device: MobileDeviceRecord = {
        id: randomUUID(),
        label: sanitizeDeviceLabel(input.label),
        platform: input.platform,
        tokenHash: hashSecret(deviceToken),
        status: 'pending',
        confirmCode: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        beCodeRef: input.beCodeRef ?? null,
        createdAt: now(),
        approvedAt: null,
        lastSeenAt: null,
        revokedAt: null,
      };
      store.insert(device);
      return { device, deviceToken };
    },

    /** Trade a device token for permission to open a session. */
    exchange(deviceId: string, deviceToken: string): ExchangeResult {
      expirePending();
      const rec = findByToken(deviceId, deviceToken);
      if (!rec) return { ok: false, reason: 'invalid' };
      if (rec.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (rec.status === 'pending') return { ok: false, reason: 'pending' };
      store.update(rec.id, { lastSeenAt: now() });
      return { ok: true, device: { ...rec, lastSeenAt: now() } };
    },

    approve(id: string): MobileDeviceView | null {
      expirePending();
      const rec = store.get(id);
      if (!rec || rec.status !== 'pending') return null;
      const approvedAt = now();
      store.update(id, { status: 'active', approvedAt });
      return toView({ ...rec, status: 'active', approvedAt });
    },

    /** Refuse a pending phone. Its row is deleted; it never had access. */
    deny(id: string): boolean {
      const rec = store.get(id);
      if (!rec || rec.status !== 'pending') return false;
      store.remove(id);
      opts.onRevoked?.({ ...rec, status: 'revoked', revokedAt: now() });
      return true;
    },

    revoke(id: string): boolean {
      const rec = store.get(id);
      if (!rec || rec.status === 'revoked') return false;
      revokeRecord(rec);
      return true;
    },

    /** The phone removes itself. Requires its own device token. */
    unpair(deviceId: string, deviceToken: string): boolean {
      const rec = findByToken(deviceId, deviceToken);
      if (!rec || rec.status === 'revoked') return false;
      revokeRecord(rec);
      return true;
    },

    list(): MobileDeviceView[] {
      expirePending();
      return store.listLive().map(toView);
    },

    /** Test seam: how many pairing codes are open. */
    openCodeCount(): number {
      pruneCodes();
      return codes.size;
    },
  };
}

export type DeviceAuth = ReturnType<typeof createDeviceAuth>;
