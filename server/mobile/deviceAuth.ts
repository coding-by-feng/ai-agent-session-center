// deviceAuth.ts — pairing phones with this Mac (AASC-15).
//
// Flow: the desktop asks for a one-time pairing code (shown as a QR). The phone
// redeems it and receives a device token at once, but the device is PENDING:
// its token can't open a session until someone approves it on the desktop,
// comparing a 6-digit confirmation code shown on both screens. An approved phone
// then proves it holds the token to get the normal one-hour session
// (authManager), so it survives server restarts without knowing the password.
//
// After pairing the token itself never travels again: the phone answers a
// single-use server nonce with HMAC-SHA256(key = SHA-256(token), nonce). On the
// unencrypted home-network path a sniffed exchange is worthless to replay.
// Device tokens are also bound to the dashboard password in force when they
// were issued: change the password and every paired phone must pair again.
//
// Pure logic over an injected store and clock, so it is testable without SQLite.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';

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
  /** Fingerprint of the dashboard password when the token was issued (null: none set). */
  credentialEpoch: string | null;
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
/** A sign-in challenge is answered within this window, once. */
export const CHALLENGE_TTL_MS = 60 * 1000;
/** Open challenges kept per device; older ones are dropped. */
const MAX_CHALLENGES_PER_DEVICE = 5;
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
  /**
   * Fingerprint of the current dashboard password. A device token issued under
   * another fingerprint is revoked on its next sign-in.
   */
  credentialEpoch?: () => string | null;
  /** Called once when a device stops being usable (deny, revoke, unpair, pending expiry). */
  onRevoked?: (device: MobileDeviceRecord) => void;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The phone's answer to a challenge: HMAC-SHA256 keyed with the SHA-256 of its
 * device token, over the nonce, hex. The server keys with the stored hash, so
 * it never needs the token. (The phone computes the same with WebCrypto.)
 */
export function challengeProof(tokenHashHex: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(tokenHashHex, 'hex')).update(nonce).digest('hex');
}

/** Convenience for callers that hold the token itself (the phone, tests). */
export function proofForToken(deviceToken: string, nonce: string): string {
  return challengeProof(hashSecret(deviceToken), nonce);
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
  const currentEpoch = (): string | null => opts.credentialEpoch?.() ?? null;
  /** Open pairing codes, keyed by their hash. In memory on purpose: they live two minutes. */
  const codes = new Map<string, { expiresAt: number }>();
  /** Open sign-in challenges, keyed by nonce. */
  const challenges = new Map<string, { deviceId: string; expiresAt: number }>();

  function pruneChallenges(): void {
    const t = now();
    for (const [nonce, entry] of challenges) if (entry.expiresAt <= t) challenges.delete(nonce);
  }

  /** Consume a challenge and check the proof against the device's stored token hash. */
  function verifyProof(deviceId: string, nonce: string, proof: string): MobileDeviceRecord | null {
    pruneChallenges();
    const entry = challenges.get(nonce);
    if (!entry || entry.deviceId !== deviceId) return null;
    challenges.delete(nonce); // single use, right or wrong
    const rec = store.get(deviceId);
    if (!rec || !/^[0-9a-f]{64}$/.test(proof)) return null;
    return sameHash(challengeProof(rec.tokenHash, nonce), proof) ? rec : null;
  }

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
        credentialEpoch: currentEpoch(),
        createdAt: now(),
        approvedAt: null,
        lastSeenAt: null,
        revokedAt: null,
      };
      store.insert(device);
      return { device, deviceToken };
    },

    /**
     * A single-use nonce for the next sign-in or unpair. Issued for any id, so
     * the answer doesn't reveal which device ids exist.
     */
    createChallenge(deviceId: string): { nonce: string; expiresAt: number } {
      pruneChallenges();
      const mine = [...challenges.entries()].filter(([, e]) => e.deviceId === deviceId);
      for (const [nonce] of mine.slice(0, Math.max(0, mine.length - MAX_CHALLENGES_PER_DEVICE + 1))) {
        challenges.delete(nonce);
      }
      const nonce = randomBytes(24).toString('base64url');
      const expiresAt = now() + CHALLENGE_TTL_MS;
      challenges.set(nonce, { deviceId, expiresAt });
      return { nonce, expiresAt };
    },

    /** Prove the device token (challenge + HMAC) for permission to open a session. */
    exchange(deviceId: string, nonce: string, proof: string): ExchangeResult {
      expirePending();
      const rec = verifyProof(deviceId, nonce, proof);
      if (!rec) return { ok: false, reason: 'invalid' };
      if (rec.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (rec.credentialEpoch !== currentEpoch()) {
        revokeRecord(rec); // the dashboard password changed since this phone paired
        return { ok: false, reason: 'revoked' };
      }
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

    /** The phone removes itself, proving its token the same way as sign-in. */
    unpair(deviceId: string, nonce: string, proof: string): boolean {
      const rec = verifyProof(deviceId, nonce, proof);
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
