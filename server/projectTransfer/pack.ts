/**
 * A pack: the bytes of some files of a plan, back to back, in the order the pack names them. Both
 * sides know every file's size from the plan, so a pack needs no framing. A file that changed since
 * the scan is still sent at its planned size (cut short or padded with zeros); its SHA-256 then fails
 * on the target, which reports it, and the source sends it again from a fresh plan.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const MAX_RANGE_PARTS = 20_000;

/** `0-5,7,9-12` for ascending, unique indexes. */
export function formatRanges(indexes: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < indexes.length) {
    let j = i;
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
    parts.push(i === j ? String(indexes[i]) : `${indexes[i]}-${indexes[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** Indexes from `formatRanges` text: ascending, unique, each below `count`; null when malformed. */
export function parseRanges(text: unknown, count: number): number[] | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 200_000) return null;
  const parts = text.split(',');
  if (parts.length > MAX_RANGE_PARTS) return null;
  const out: number[] = [];
  let last = -1;
  for (const part of parts) {
    const m = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from <= last || to < from || to >= count) return null;
    for (let k = from; k <= to; k++) out.push(k);
    last = to;
  }
  return out;
}

/**
 * Exactly `size` bytes of the file at `path`: cut short, or padded with zeros when it shrank, vanished
 * or is no longer a plain file. Opened without following a link: a file swapped for a link after the
 * scan (to a key file, say) must not have its target's bytes sent (security review, Nov 27 2026).
 */
export async function* exactBytes(path: string, size: number): AsyncGenerator<Buffer> {
  let sent = 0;
  if (size > 0) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    try {
      if (!handle || !(await handle.stat()).isFile()) throw new Error('not a plain file');
      for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, highWaterMark: 1 << 20, autoClose: false })) {
        const buf = chunk as Buffer;
        const take = Math.min(buf.length, size - sent);
        if (take > 0) yield buf.subarray(0, take);
        sent += take;
        if (sent >= size) break;
      }
    } catch {
      // vanished, unreadable or swapped since the scan: padded below, and its hash fails on the target
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  while (sent < size) {
    const n = Math.min(1 << 20, size - sent);
    yield Buffer.alloc(n);
    sent += n;
  }
}

/** The pack for `files` (each with its path and planned size), as one stream of chunks. */
export async function* packStream(files: readonly { abs: string; size: number }[]): AsyncGenerator<Buffer> {
  for (const f of files) yield* exactBytes(f.abs, f.size);
}

/** Reads exact byte counts from a stream of chunks (an HTTP request body). */
export class ExactReader {
  private readonly it: AsyncIterator<Buffer | Uint8Array | string>;
  private rest: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer | Uint8Array | string>) {
    this.it = source[Symbol.asyncIterator]();
  }

  /** Hand the next `n` bytes to `sink` piece by piece; false when the stream ends first. */
  async read(n: number, sink: (piece: Buffer) => void | Promise<void>): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (this.rest.length === 0) {
        if (this.ended) return false;
        const next = await this.it.next();
        if (next.done) {
          this.ended = true;
          return false;
        }
        const v = next.value;
        this.rest = typeof v === 'string' ? Buffer.from(v) : Buffer.isBuffer(v) ? v : Buffer.from(v);
        continue;
      }
      const take = Math.min(left, this.rest.length);
      const piece = this.rest.subarray(0, take);
      this.rest = this.rest.subarray(take);
      left -= take;
      await sink(piece);
    }
    return true;
  }
}
