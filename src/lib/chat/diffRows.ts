/**
 * diffRows.ts — how a diff hunk is drawn on the phone (AASC-44, and the chat's
 * inline edit diffs, AASC-41): one row per line with its old and new line number,
 * the hunk's header, and the reference "Hold a line → Comment" puts into the
 * composer draft. Pure.
 *
 * A start of 0 means the transcript didn't record where the hunk sits (an edit's
 * snippet, a patch hunk): such rows have no numbers, and a comment quotes the line.
 */
import type { DiffHunk } from '@/types/chat';

const MINUS = '−';
const QUOTE_MAX = 60;

export type DiffRowKind = 'context' | 'add' | 'del';

export interface DiffRow {
  kind: DiffRowKind;
  /** The line without its ' ' / '+' / '-' prefix. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function hunkRows(hunk: DiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart > 0 ? hunk.oldStart : null;
  let newNo = hunk.newStart > 0 ? hunk.newStart : null;
  const rows: DiffRow[] = [];
  for (const line of hunk.lines) {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '+') {
      rows.push({ kind: 'add', text, oldNo: null, newNo });
      if (newNo !== null) newNo += 1;
    } else if (sign === '-') {
      rows.push({ kind: 'del', text, oldNo, newNo: null });
      if (oldNo !== null) oldNo += 1;
    } else {
      rows.push({ kind: 'context', text, oldNo, newNo });
      if (oldNo !== null) oldNo += 1;
      if (newNo !== null) newNo += 1;
    }
  }
  return rows;
}

/** Does any hunk say where it sits in the file? */
export function positionsKnown(hunks: readonly DiffHunk[]): boolean {
  return hunks.some((h) => h.oldStart > 0 || h.newStart > 0);
}

/** "@@ −40,7 +40,7 @@", or "Change 2" for a hunk with no recorded position. */
export function hunkHeader(hunk: DiffHunk, index: number): string {
  if (hunk.oldStart <= 0 && hunk.newStart <= 0) return `Change ${index + 1}`;
  return `@@ ${MINUS}${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** What a line's Comment puts into the draft: "src/ui/icons.tsx:41 — ". */
export function commentReference(path: string, row: DiffRow): string {
  if (row.kind === 'del' && row.oldNo !== null) return `${path}:${row.oldNo} (removed line) — `;
  if (row.kind !== 'del' && row.newNo !== null) return `${path}:${row.newNo} — `;
  const text = row.text.trim();
  const quoted = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text;
  return `${path} “${quoted}” — `;
}
