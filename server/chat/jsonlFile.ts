/**
 * @module jsonlFile
 * Reading whole lines of a JSONL transcript by byte range, shared by the chat pager and the redaction
 * lookups that walk back through the same file.
 */
import type { FileHandle } from 'node:fs/promises';

export const NEWLINE = 0x0a;

/** Bytes `from`..`to` of the file (fewer only at its end). */
export async function readRange(fh: FileHandle, from: number, to: number): Promise<Buffer> {
  const length = Math.max(0, to - from);
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, from + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

/** A JSON record, or null for a line that isn't one (half-written, or not JSON). */
export function parseRecord(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface Line {
  offset: number;
  /** Offset just past the line (past its newline when it has one). */
  next: number;
  text: string;
  complete: boolean;
}

/**
 * The lines of `buf`, which starts at byte `base`. Unless `startsAtLine`, the first segment is the
 * tail of a line that began earlier and is dropped.
 */
export function splitLines(buf: Buffer, base: number, startsAtLine: boolean): Line[] {
  let at = 0;
  if (!startsAtLine) {
    const nl = buf.indexOf(NEWLINE);
    if (nl < 0) return [];
    at = nl + 1;
  }
  const lines: Line[] = [];
  while (at < buf.length) {
    const nl = buf.indexOf(NEWLINE, at);
    const stop = nl < 0 ? buf.length : nl;
    const next = nl < 0 ? buf.length : nl + 1;
    lines.push({ offset: base + at, next: base + next, text: buf.toString('utf8', at, stop), complete: nl >= 0 });
    at = next;
  }
  return lines;
}
