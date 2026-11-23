/**
 * fileRefJoin — a file path an agent's output splits across two terminal lines (Nov 23 2026). Codex wraps its own
 * text with a real line break and an indent, so a long path ends one line (`…/黎曼猜想-验过10`) and goes on at the
 * start of the next (`  万亿个零点为什么还要证明.mp4）`); a long line the terminal soft-wraps splits the same way. Per
 * line, findFileRefs saw neither half as the path (or linked a wrong half). Here the upper line's last path-like run
 * and the lower line's first one (after its indent) are put back together and scanned again; only a match that
 * crosses the seam counts. Pure: the caller links one only after the Mac confirms it exists (resolveFileRef), so a
 * line that merely ends in a path-ish word never becomes a false link.
 */
import { findFileRefs, type FileRefKind } from './fileRefs';

/** One path-like character: as fileRefs' segments, plus the separators a path is cut at. */
const TAIL = /[\p{L}\p{N}\p{M}@.+_~/-]+$/u;
const HEAD = /^[\p{L}\p{N}\p{M}@.+_~/-]+/u;

export interface JoinedRef {
  /** The whole path, both halves. */
  text: string;
  kind: FileRefKind;
  /** Code-unit offsets in the upper line's text: the path starts here and runs to its end. */
  upperStart: number;
  upperEnd: number;
  /** Code-unit offsets in the lower line's text (exclusive end). */
  lowerStart: number;
  lowerEnd: number;
}

/** The path that runs from the end of `upper` onto the start of `lower`, or null. */
export function findJoinedRef(upper: string, lower: string): JoinedRef | null {
  const upperText = upper.replace(/\s+$/u, '');
  const lead = lower.length - lower.replace(/^\s+/u, '').length;
  const tail = TAIL.exec(upperText)?.[0];
  const head = HEAD.exec(lower.slice(lead))?.[0];
  if (!tail || !head) return null;
  // The upper half is an unfinished path: it has a folder part, and is not already a whole file path (a path that
  // ends one line is finished; the next line is new text). The rare path cut inside its extension stays unjoined.
  if (!tail.includes('/')) return null;
  if (findFileRefs(tail).some((t) => t.kind === 'file' && t.end === tail.length)) return null;
  const tailStart = upperText.length - tail.length;
  const seam = tail.length;
  const joined = tail + head;
  const token = findFileRefs(joined).find((t) => t.start < seam && t.end > seam && t.text.includes('/'));
  if (!token) return null;
  return {
    text: token.text,
    kind: token.kind,
    upperStart: tailStart + token.start,
    upperEnd: upperText.length,
    lowerStart: lead,
    lowerEnd: lead + (token.end - seam),
  };
}
