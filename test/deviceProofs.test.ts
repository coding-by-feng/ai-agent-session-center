// test/deviceProofs.test.ts — the keyed proofs a paired device and this machine trade (server/mobile/deviceProofs.ts,
// split out of deviceAuth.ts), and the two steps of this machine's proof of itself (POST /api/mobile/identify).
//
// The proof is asked in two steps so the route can decide what it may do for the caller before it does it: only a
// device this machine vouches for gets an answer that depends on the addresses the machine publishes; any other tag
// gets the decoy, over the socket address, with no lookup (mobileRouter.ts, test/mobileIdentifyComputer.test.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as fromAuth from '../server/mobile/deviceAuth.js';
import * as proofs from '../server/mobile/deviceProofs.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';

function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

const NONCE = 'c3'.repeat(32);
const AT = '192.168.1.57:3333';
const ELSEWHERE = '45.63.31.79:3333';
const TOKEN = 'd'.repeat(43);
const tokenHash = createHash('sha256').update(TOKEN).digest('hex');
const keyed = (message: string) => createHmac('sha256', Buffer.from(tokenHash, 'hex')).update(message).digest('hex');

describe('the proofs (deviceProofs.ts)', () => {
  it('are what they were in deviceAuth.ts, byte for byte', () => {
    expect(proofs.hashSecret(TOKEN)).toBe(tokenHash);
    expect(proofs.challengeProof(tokenHash, 'nonce')).toBe(keyed('nonce'));
    expect(proofs.proofForToken(TOKEN, 'nonce')).toBe(keyed('nonce'));
    expect([proofs.WHO_TAG_PREFIX, proofs.MAC_PROOF_PREFIX, proofs.PATHS_PROOF_PREFIX]).toEqual(['aasc-who:', 'aasc-mac:', 'aasc-paths:']);
  });

  it('are still exported by deviceAuth.ts, as the very same things', () => {
    for (const name of ['hashSecret', 'challengeProof', 'proofForToken', 'WHO_TAG_PREFIX', 'MAC_PROOF_PREFIX', 'PATHS_PROOF_PREFIX'] as const) {
      expect(fromAuth[name]).toBe(proofs[name]);
    }
  });

  it('sameHash compares two hex strings in full, and never throws on a length that differs', () => {
    expect(proofs.sameHash(tokenHash, tokenHash)).toBe(true);
    expect(proofs.sameHash(tokenHash, `${tokenHash.slice(0, 63)}0`)).toBe(tokenHash.endsWith('0'));
    expect(proofs.sameHash(tokenHash, tokenHash.slice(0, 62))).toBe(false);
    expect(proofs.sameHash(tokenHash, '')).toBe(false);
  });
});

describe('machineProver', () => {
  const decoyKey = randomBytes(32);
  const tag = keyed(`aasc-who:${NONCE}`);

  it('for a device this machine vouches for: the device\'s key over the address', () => {
    const prover = proofs.machineProver(tokenHash, decoyKey, tag, NONCE);
    expect(prover.vouched).toBe(true);
    expect(prover.over(AT)).toBe(keyed(`aasc-mac:${NONCE}:${AT}`));
    expect(prover.over(ELSEWHERE)).toBe(keyed(`aasc-mac:${NONCE}:${ELSEWHERE}`));
  });

  it('for any other tag: a decoy of the same shape, the same for the same question, and no proof of anything', () => {
    const prover = proofs.machineProver(null, decoyKey, tag, NONCE);
    expect(prover.vouched).toBe(false);
    expect(prover.over(AT)).toBe(createHmac('sha256', decoyKey).update(`${tag}:${NONCE}:${AT}`).digest('hex'));
    expect(prover.over(AT)).toBe(prover.over(AT));
    expect(prover.over(AT)).not.toBe(prover.over(ELSEWHERE));
    expect(prover.over(AT)).not.toBe(keyed(`aasc-mac:${NONCE}:${AT}`));
    expect(proofs.machineProver(null, randomBytes(32), tag, NONCE).over(AT)).not.toBe(prover.over(AT)); // keyed per server run
  });
});

describe('deviceAuth.macProver', () => {
  const tagOf = (deviceToken: string) => proofs.challengeProof(proofs.hashSecret(deviceToken), `aasc-who:${NONCE}`);
  function setUp() {
    const state = { epoch: 'epoch-1' };
    const auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => state.epoch });
    const pair = (approve: boolean) => {
      const { code } = auth.createPairingCode();
      const out = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
      if (approve) auth.approve(out.device.id);
      return out;
    };
    return { auth, state, pair };
  }

  it('vouches for an allowed device paired under the current password, and proves over the address it is given', () => {
    const f = setUp();
    const { deviceToken } = f.pair(true);
    const prover = f.auth.macProver(tagOf(deviceToken), NONCE);
    expect(prover.vouched).toBe(true);
    expect(prover.over(AT)).toBe(proofs.challengeProof(proofs.hashSecret(deviceToken), `aasc-mac:${NONCE}:${AT}`));
  });

  it.each([
    ['a tag nobody holds', (f: ReturnType<typeof setUp>) => { f.pair(true); return 'k'.repeat(43); }],
    ['a device still waiting for Allow', (f: ReturnType<typeof setUp>) => f.pair(false).deviceToken],
    ['a revoked device', (f: ReturnType<typeof setUp>) => { const out = f.pair(true); f.auth.revoke(out.device.id); return out.deviceToken; }],
    ['a device paired under an earlier password', (f: ReturnType<typeof setUp>) => { const out = f.pair(true); f.state.epoch = 'epoch-2'; return out.deviceToken; }],
  ])('does not vouch for %s: a decoy, whatever the address', (_label, make) => {
    const f = setUp();
    const deviceToken = make(f);
    const prover = f.auth.macProver(tagOf(deviceToken), NONCE);
    expect(prover.vouched).toBe(false);
    expect(prover.over(AT)).toMatch(/^[0-9a-f]{64}$/);
    expect(prover.over(AT)).not.toBe(proofs.challengeProof(proofs.hashSecret(deviceToken), `aasc-mac:${NONCE}:${AT}`));
  });

  it('macProof is the two steps in one, as it always answered', () => {
    const f = setUp();
    const { deviceToken } = f.pair(true);
    for (const tag of [tagOf(deviceToken), tagOf('k'.repeat(43))]) {
      for (const address of [AT, ELSEWHERE]) {
        expect(f.auth.macProof(tag, NONCE, address)).toBe(f.auth.macProver(tag, NONCE).over(address));
      }
    }
  });
});
