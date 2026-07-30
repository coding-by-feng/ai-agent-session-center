/**
 * Terminal replay ring buffer — lazily grown slab + write offset, O(1) append.
 *
 * Replaces a Buffer.concat-every-chunk approach that was O(n) per write and
 * allocated garbage for every PTY data event.
 *
 * Rings used to be allocated at their full cap the moment a terminal was
 * created — 2 MB by default, up to 32 MB — so N idle terminals cost N × cap of
 * resident memory whether or not they ever produced a byte. Measured on a live
 * app with ~23 terminals that was ~46 MB of zero-filled slab sitting in the
 * Electron main process. Rings now start at INITIAL_RING_BYTES and double toward
 * the cap only as output actually arrives.
 *
 * NOTE: duplicated verbatim in `electron/ptyRing.ts`. The Electron main process
 * (tsconfig rootDir `electron`) and the server bundle (tsconfig include
 * `server`) cannot import across each other's roots, and `src/types` is not
 * visible to the Electron build either. `test/ptyRing.test.ts` runs one suite
 * against both copies so they cannot drift.
 */

export interface RingState {
  /** Current allocation — grows toward `cap`. This is NOT the capacity. */
  buf: Buffer;
  /** Next write offset within `buf`. */
  offset: number;
  /** True once `buf` has wrapped at least once — only reachable at `cap`. */
  wrapped: boolean;
  /** Maximum size `buf` may grow to, fixed for the life of the terminal. */
  cap: number;
}

/** Starting allocation for a new ring — a screenful of output, not the full cap. */
export const INITIAL_RING_BYTES = 64 * 1024;

/** Allocation a freshly created ring should start at, given its cap. */
export function initialRingBytes(cap: number): number {
  return Math.min(INITIAL_RING_BYTES, cap);
}

export function createRing(cap: number): RingState {
  return { buf: Buffer.alloc(initialRingBytes(cap)), offset: 0, wrapped: false, cap };
}

/**
 * Capacity a ring must have to hold `needed` bytes of linear content, doubling
 * from `current` and never exceeding `cap`. Returns `current` when no growth is
 * required, so callers can skip reallocating.
 *
 * Growth also triggers when `needed === current`, not just when it exceeds it:
 * a write landing exactly on the end of a not-yet-full ring would flip it to
 * "wrapped" at the smaller size, silently capping replay far below the buffer
 * size the user configured. Growing instead preserves the invariant below.
 */
export function nextRingCapacity(current: number, needed: number, cap: number): number {
  if (current >= cap) return current;
  if (needed < current) return current;
  let next = Math.max(current, 1);
  while (next <= needed && next < cap) next *= 2;
  return Math.min(cap, next);
}

/**
 * Grow the ring so a quiet terminal never holds the full slab.
 *
 * INVARIANT: a ring can only wrap once `buf.length === cap`. ringWrite grows
 * before every write, and growth only stops at the cap, so any write that would
 * wrap a smaller buffer enlarges it first. That is what makes this function
 * safe: while growing, the live bytes are always the linear prefix
 * `[0, offset)` and copy straight across — there is no wrap boundary to
 * re-order. The `wrapped` guard makes the invariant explicit and keeps this a
 * no-op afterwards.
 */
function ringGrow(ring: RingState, incoming: number): void {
  if (ring.wrapped) return;
  const size = nextRingCapacity(ring.buf.length, ring.offset + incoming, ring.cap);
  if (size <= ring.buf.length) return;
  const grown = Buffer.alloc(size);
  ring.buf.copy(grown, 0, 0, ring.offset);
  ring.buf = grown;
}

export function ringWrite(ring: RingState, chunk: Buffer): void {
  ringGrow(ring, chunk.length);
  const cap = ring.buf.length;
  if (chunk.length >= cap) {
    // Incoming chunk larger than the ring — keep only the tail.
    chunk.copy(ring.buf, 0, chunk.length - cap);
    ring.offset = 0;
    ring.wrapped = true;
    return;
  }
  const tail = cap - ring.offset;
  if (chunk.length <= tail) {
    chunk.copy(ring.buf, ring.offset);
    ring.offset += chunk.length;
    if (ring.offset === cap) {
      ring.offset = 0;
      ring.wrapped = true;
    }
  } else {
    chunk.copy(ring.buf, ring.offset, 0, tail);
    chunk.copy(ring.buf, 0, tail);
    ring.offset = chunk.length - tail;
    ring.wrapped = true;
  }
}

/**
 * Linearize the ring (oldest → newest).
 *
 * The un-wrapped branch returns a *view* into the live buffer, matching the
 * long-standing behaviour callers rely on — every caller either copies it
 * (Buffer.concat) or stringifies it immediately.
 */
export function ringSnapshot(ring: RingState): Buffer {
  if (!ring.wrapped) return ring.buf.subarray(0, ring.offset);
  return Buffer.concat([ring.buf.subarray(ring.offset), ring.buf.subarray(0, ring.offset)]);
}

export function ringLength(ring: RingState): number {
  return ring.wrapped ? ring.buf.length : ring.offset;
}

/** Clear the ring, optionally seeding it with `preload` (must not alias `ring.buf`). */
export function ringReset(ring: RingState, preload?: Buffer): void {
  ring.buf.fill(0);
  ring.offset = 0;
  ring.wrapped = false;
  if (preload && preload.length > 0) ringWrite(ring, preload);
}
