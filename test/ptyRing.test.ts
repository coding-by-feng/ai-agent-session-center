import { describe, it, expect } from 'vitest';
import * as serverRing from '../server/ptyRing.js';
import * as electronRing from '../electron/ptyRing.js';

/**
 * The ring is duplicated across the Electron main process and the server bundle
 * because their tsconfig roots cannot see each other. Running the same suite
 * against both copies is what stops them drifting — change one and this fails
 * until you change the other.
 */
const IMPLS = [
  ['server/ptyRing', serverRing],
  ['electron/ptyRing', electronRing],
] as const;

const KB = 1024;
const MB = 1024 * KB;

/** Deterministic filler so assertions can check exact bytes, not just lengths. */
const fill = (n: number, seed = 0) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i + seed) % 251));

describe.each(IMPLS)('%s', (_name, ring) => {
  const {
    createRing, ringWrite, ringSnapshot, ringLength, ringReset,
    nextRingCapacity, initialRingBytes, INITIAL_RING_BYTES,
  } = ring;

  describe('allocation', () => {
    it('starts far below a normal cap instead of allocating it up front', () => {
      const r = createRing(2 * MB);
      expect(r.buf.length).toBe(INITIAL_RING_BYTES);
      expect(r.buf.length).toBeLessThan(2 * MB);
      expect(r.cap).toBe(2 * MB);
    });

    it('never starts above the cap', () => {
      expect(createRing(16 * KB).buf.length).toBe(16 * KB);
      expect(initialRingBytes(16 * KB)).toBe(16 * KB);
    });

    it('stays small while output is small', () => {
      const r = createRing(32 * MB);
      ringWrite(r, fill(1000));
      expect(r.buf.length).toBe(INITIAL_RING_BYTES);
    });
  });

  describe('nextRingCapacity', () => {
    it('does not grow when the write fits with room to spare', () => {
      expect(nextRingCapacity(64 * KB, 30 * KB, 2 * MB)).toBe(64 * KB);
    });

    it('grows when a write would land exactly on the end of the buffer', () => {
      // Without this the ring flips to "wrapped" at 64 KB and silently caps
      // replay at 1/32nd of the configured 2 MB.
      expect(nextRingCapacity(64 * KB, 64 * KB, 2 * MB)).toBe(128 * KB);
    });

    it('doubles until the write fits, never past the cap', () => {
      expect(nextRingCapacity(64 * KB, 200 * KB, 2 * MB)).toBe(256 * KB);
      expect(nextRingCapacity(1 * MB, 1.5 * MB, 2 * MB)).toBe(2 * MB);
      expect(nextRingCapacity(64 * KB, 100 * MB, 2 * MB)).toBe(2 * MB);
    });

    it('is a no-op once the ring has reached its cap', () => {
      expect(nextRingCapacity(2 * MB, 10 * MB, 2 * MB)).toBe(2 * MB);
    });

    it('terminates and grows from a degenerate zero-length ring', () => {
      expect(nextRingCapacity(0, 0, 1 * MB)).toBeGreaterThan(0);
      expect(nextRingCapacity(0, 5000, 1 * MB)).toBeGreaterThan(5000);
    });

    it('returns a size that fits the write, or exactly the cap', () => {
      for (const needed of [0, 1, 63 * KB, 64 * KB, 65 * KB, 700 * KB, 3 * MB]) {
        const size = nextRingCapacity(64 * KB, needed, 2 * MB);
        expect(size > needed || size === 2 * MB).toBe(true);
      }
    });
  });

  describe('growth preserves content', () => {
    it('keeps every byte across many growth steps', () => {
      const r = createRing(1 * MB);
      const chunks: Buffer[] = [];
      for (let i = 0; i < 40; i++) {
        const c = fill(10 * KB, i);
        chunks.push(c);
        ringWrite(r, c);
      }
      const expected = Buffer.concat(chunks);
      expect(r.buf.length).toBeGreaterThan(INITIAL_RING_BYTES); // it really grew
      expect(ringLength(r)).toBe(expected.length);
      expect(ringSnapshot(r).equals(expected)).toBe(true);
    });

    it('matches an eagerly-allocated ring byte for byte', () => {
      // The pre-F2 behaviour: a ring born at full size. Lazy growth must be
      // indistinguishable from it for any write sequence.
      const lazy = createRing(256 * KB);
      const eager = { buf: Buffer.alloc(256 * KB), offset: 0, wrapped: false, cap: 256 * KB };
      for (let i = 0; i < 30; i++) {
        const c = fill(17 * KB, i);
        ringWrite(lazy, c);
        ringWrite(eager, c);
      }
      expect(lazy.buf.length).toBe(eager.buf.length); // both ended at the cap
      expect(ringLength(lazy)).toBe(ringLength(eager));
      expect(ringSnapshot(lazy).equals(ringSnapshot(eager))).toBe(true);
    });

    it('never wraps before reaching the cap', () => {
      const r = createRing(1 * MB);
      for (let i = 0; i < 200; i++) {
        ringWrite(r, fill(4 * KB, i));
        if (r.wrapped) expect(r.buf.length).toBe(r.cap);
      }
    });

    it('grows to exactly the cap and no further', () => {
      const r = createRing(256 * KB);
      for (let i = 0; i < 100; i++) ringWrite(r, fill(8 * KB, i));
      expect(r.buf.length).toBe(256 * KB);
      expect(r.wrapped).toBe(true);
    });
  });

  describe('wrapping', () => {
    it('keeps only the newest cap bytes once full', () => {
      const cap = 128 * KB;
      const r = createRing(cap);
      const all = fill(cap * 3, 7);
      // Write in pieces so the ring both grows and then wraps.
      for (let i = 0; i < all.length; i += 7 * KB) {
        ringWrite(r, all.subarray(i, Math.min(i + 7 * KB, all.length)));
      }
      expect(ringLength(r)).toBe(cap);
      expect(ringSnapshot(r).equals(all.subarray(all.length - cap))).toBe(true);
    });

    it('keeps the tail when a single chunk exceeds the cap', () => {
      const cap = 64 * KB;
      const r = createRing(cap);
      const huge = fill(cap * 2 + 123, 3);
      ringWrite(r, huge);
      expect(r.wrapped).toBe(true);
      expect(ringSnapshot(r).equals(huge.subarray(huge.length - cap))).toBe(true);
    });

    it('handles a chunk that straddles the wrap boundary', () => {
      const cap = 32 * KB;
      const r = createRing(cap);
      ringWrite(r, fill(cap, 1));          // exactly fills → wrapped
      const straddle = fill(5 * KB, 9);
      ringWrite(r, straddle);
      const snap = ringSnapshot(r);
      expect(snap.length).toBe(cap);
      expect(snap.subarray(cap - straddle.length).equals(straddle)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('reports an empty ring as zero-length', () => {
      const r = createRing(1 * MB);
      expect(ringLength(r)).toBe(0);
      expect(ringSnapshot(r).length).toBe(0);
    });

    it('tolerates empty writes', () => {
      const r = createRing(1 * MB);
      ringWrite(r, Buffer.alloc(0));
      expect(ringLength(r)).toBe(0);
      ringWrite(r, fill(10));
      ringWrite(r, Buffer.alloc(0));
      expect(ringLength(r)).toBe(10);
    });

    it('handles a cap smaller than the initial allocation', () => {
      const r = createRing(4 * KB);
      const data = fill(10 * KB);
      ringWrite(r, data);
      expect(ringLength(r)).toBe(4 * KB);
      expect(ringSnapshot(r).equals(data.subarray(data.length - 4 * KB))).toBe(true);
    });
  });

  describe('ringReset', () => {
    it('clears the ring', () => {
      const r = createRing(1 * MB);
      ringWrite(r, fill(100 * KB));
      ringReset(r);
      expect(ringLength(r)).toBe(0);
      expect(r.wrapped).toBe(false);
    });

    it('seeds from a preload, growing as needed', () => {
      const r = createRing(1 * MB);
      const preload = fill(300 * KB, 5);
      ringReset(r, preload);
      expect(ringLength(r)).toBe(preload.length);
      expect(ringSnapshot(r).equals(preload)).toBe(true);
    });

    it('truncates a preload larger than the cap to its tail', () => {
      const cap = 64 * KB;
      const r = createRing(cap);
      const preload = fill(cap * 2, 11);
      ringReset(r, preload);
      expect(ringSnapshot(r).equals(preload.subarray(preload.length - cap))).toBe(true);
    });
  });
});

describe('ring parity across the two copies', () => {
  it('agrees on capacity for every sampled input', () => {
    const caps = [16 * KB, 256 * KB, 2 * MB, 32 * MB];
    const sizes = [0, 1, 64 * KB, 128 * KB, 1 * MB, 32 * MB];
    for (const cap of caps) {
      expect(electronRing.initialRingBytes(cap)).toBe(serverRing.initialRingBytes(cap));
      for (const current of sizes) {
        for (const needed of sizes) {
          expect(electronRing.nextRingCapacity(current, needed, cap))
            .toBe(serverRing.nextRingCapacity(current, needed, cap));
        }
      }
    }
  });

  it('produces identical buffers for an identical write sequence', () => {
    const s = serverRing.createRing(128 * KB);
    const e = electronRing.createRing(128 * KB);
    for (let i = 0; i < 60; i++) {
      const c = fill(5 * KB, i);
      serverRing.ringWrite(s, c);
      electronRing.ringWrite(e, c);
    }
    expect(e.buf.length).toBe(s.buf.length);
    expect(e.offset).toBe(s.offset);
    expect(e.wrapped).toBe(s.wrapped);
    expect(electronRing.ringSnapshot(e).equals(serverRing.ringSnapshot(s))).toBe(true);
  });

  it('shares the same starting size', () => {
    expect(electronRing.INITIAL_RING_BYTES).toBe(serverRing.INITIAL_RING_BYTES);
  });
});
