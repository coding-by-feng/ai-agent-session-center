/**
 * fileStreamPolicy — what `/api/files/read` and `/api/files/stream` refuse for size, and how a
 * `Range` header is read.
 *
 * PDFs, images and Office files are loaded whole (PDF.js, `<img>`, mammoth), so they keep a
 * 100 MB cap. Video and audio are played through HTTP Range requests, a chunk at a time, so they
 * have none (Nov 5 2026: a 133.8 MB .mp4 was "too large to open" on the phone). With no cap, the
 * Range header is all that bounds a read, so it is parsed strictly here.
 */

/** Whole-file streamable types (PDF, images, Office) above this are refused with 413. */
export const MAX_STREAMABLE_SIZE = 100 * 1024 * 1024;

/** Extensions (with the dot, as `extname` gives them) the browser plays through Range requests. */
const RANGE_STREAMED_EXTS: ReadonlySet<string> = new Set([
  '.mp4', '.webm', '.ogg', '.mov',
  '.mp3', '.wav', '.flac', '.aac', '.m4a',
]);

export function isRangeStreamedExt(ext: string): boolean {
  return RANGE_STREAMED_EXTS.has(ext.toLowerCase());
}

/** True when a streamable file of this extension and size is refused as too large. */
export function refusesStreamSize(ext: string, size: number): boolean {
  return !isRangeStreamedExt(ext) && size > MAX_STREAMABLE_SIZE;
}

export interface ByteRange {
  start: number;
  /** Inclusive, never past the last byte. */
  end: number;
}

const SINGLE_RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * One byte range out of a `Range` header, for a file of `size` bytes.
 * - `null`: no usable header (absent, another unit, several ranges) → send the whole file (200).
 * - `'unsatisfiable'`: a range that names no byte of the file → 416.
 * - otherwise the range, its end clamped to the last byte; `bytes=-N` is the last N bytes.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.startsWith('bytes=')) return null;
  if (value.includes(',')) return null;
  const match = SINGLE_RANGE_RE.exec(value);
  if (!match) return 'unsatisfiable';
  const [, startText, endText] = match;
  if (size <= 0) return 'unsatisfiable';
  const last = size - 1;

  if (startText === '') {
    // Suffix range: the last N bytes.
    if (endText === '') return 'unsatisfiable';
    const suffix = Number(endText);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: last };
  }

  const start = Number(startText);
  const end = endText === '' ? last : Math.min(Number(endText), last);
  if (start > last || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * `Content-Disposition` for `/api/files/stream?download=1` (Nov 7 2026: the phone's Download button).
 * `attachment` makes a browser save instead of play; the quoted name is an ASCII stand-in for old
 * clients, `filename*` carries the real one (RFC 6266 / 5987), so a CJK or spaced name survives.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
