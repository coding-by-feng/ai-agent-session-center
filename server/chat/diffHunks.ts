/**
 * @module diffHunks
 * Unified-diff hunks for the Changes view (AASC-44), from what a transcript holds: the CLI's own
 * structured patch, two versions of an edited text, a whole file's content, a unified diff, or a
 * Codex `apply_patch` patch. Nothing here reads a file.
 */
import { parsePatch, structuredPatch } from 'diff';
import type { DiffHunk } from '../../src/types/chat.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** jsdiff's "\ No newline at end of file" markers carry no change of their own. */
const isChangeLine = (line: string): boolean => line[0] === ' ' || line[0] === '+' || line[0] === '-';

export function countLines(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line[0] === '+') added += 1;
      else if (line[0] === '-') removed += 1;
    }
  }
  return { added, removed };
}

/** Characters a hunk adds to a file's budget. */
export const hunkChars = (h: DiffHunk): number => h.lines.reduce((n, l) => n + l.length + 1, 0);

/** Hunks in the shape the CLI wrote them (Claude's `structuredPatch`), or null when they aren't. */
export function hunksFrom(value: unknown): DiffHunk[] | null {
  if (!Array.isArray(value)) return null;
  const hunks: DiffHunk[] = [];
  for (const h of value) {
    if (!isRec(h) || !Array.isArray(h.lines)) return null;
    hunks.push({
      oldStart: num(h.oldStart),
      oldLines: num(h.oldLines),
      newStart: num(h.newStart),
      newLines: num(h.newLines),
      lines: h.lines.filter((l): l is string => typeof l === 'string' && isChangeLine(l)),
    });
  }
  return hunks;
}

/** Text ending in a newline, so a last line without one doesn't diff as changed. */
const withEol = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/**
 * A diff runs on the server's event loop, and two very different 1 MB texts take minutes: past
 * this many edits or this long, it gives up and the change shows as a rewrite.
 */
const DIFF_MAX_EDIT_LENGTH = 5000;
const DIFF_TIMEOUT_MS = 100;

/** The hunks between two texts, or null when they are too different to diff cheaply. */
function diff(before: string, after: string): DiffHunk[] | null {
  const patch = structuredPatch('a', 'b', withEol(before), withEol(after), '', '', {
    context: 3,
    maxEditLength: DIFF_MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  return patch ? patch.hunks.map((h) => ({ ...h, lines: h.lines.filter(isChangeLine) })) : null;
}

/** Two versions of a whole file: real line numbers; null when too different to diff cheaply. */
export const contentHunks = (before: string, after: string): DiffHunk[] | null => diff(before, after);

/** Two versions of an edited piece of a file: where in the file isn't known, so starts are 0. */
export function snippetHunks(before: string, after: string): DiffHunk[] | null {
  return diff(before, after)?.map((h) => ({ ...h, oldStart: 0, newStart: 0 })) ?? null;
}

/** A rewrite shown whole: every old line removed, every new line added. */
export function rewriteHunks(before: string, after: string, whereKnown: boolean): DiffHunk[] {
  const hunks = [...allRemoved(before), ...allAdded(after)];
  return whereKnown ? hunks : hunks.map((h) => ({ ...h, oldStart: 0, newStart: 0 }));
}

/** The lines of a file's content (a last newline ends the last line, it doesn't start one). */
export function contentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A whole file added. */
export function allAdded(content: string): DiffHunk[] {
  const lines = contentLines(content);
  return lines.length === 0 ? [] : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
}

/** A whole file removed. */
export function allRemoved(content: string): DiffHunk[] {
  const lines = contentLines(content);
  return lines.length === 0 ? [] : [{ oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) }];
}

/** The hunks of a unified diff (`@@ -a,b +c,d @@` …); none when it doesn't parse. */
export function unifiedHunks(text: string): DiffHunk[] {
  try {
    return parsePatch(text).flatMap((file) => file.hunks.map((h) => ({ ...h, lines: h.lines.filter(isChangeLine) })));
  } catch {
    return [];
  }
}

// ── Codex apply_patch ────────────────────────────────────────────────────────

export interface PatchOp {
  kind: 'add' | 'update' | 'delete';
  path: string;
  movePath?: string;
  hunks: DiffHunk[];
}

const ADD = '*** Add File: ';
const UPDATE = '*** Update File: ';
const DELETE = '*** Delete File: ';
const MOVE = '*** Move to: ';

function sized(lines: string[], whole: boolean): DiffHunk {
  const oldLines = lines.filter((l) => l[0] === ' ' || l[0] === '-').length;
  const newLines = lines.filter((l) => l[0] === ' ' || l[0] === '+').length;
  return { oldStart: 0, oldLines, newStart: whole && newLines > 0 ? 1 : 0, newLines, lines };
}

/**
 * The file operations of an `apply_patch` patch:
 *   *** Begin Patch / *** Add File: p (+lines) / *** Update File: p [*** Move to: q] (@@ hunks) /
 *   *** Delete File: p / *** End Patch
 * Its hunks carry no line numbers, so their starts are 0.
 */
export function parseApplyPatch(text: string): PatchOp[] {
  interface Open { kind: PatchOp['kind']; path: string; movePath?: string; hunks: string[][] }
  const ops: PatchOp[] = [];
  const close = (o: Open | null): null => {
    if (o && o.path) {
      const hunks = o.hunks.filter((h) => h.length > 0).map((h) => sized(h, o.kind === 'add'));
      ops.push({ kind: o.kind, path: o.path, ...(o.movePath ? { movePath: o.movePath } : {}), hunks });
    }
    return null;
  };
  let op = null as Open | null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(ADD) || line.startsWith(UPDATE) || line.startsWith(DELETE)) {
      op = close(op);
      const kind = line.startsWith(ADD) ? 'add' : line.startsWith(UPDATE) ? 'update' : 'delete';
      const prefix = kind === 'add' ? ADD : kind === 'update' ? UPDATE : DELETE;
      op = { kind, path: line.slice(prefix.length).trim(), hunks: [[]] };
    } else if (line.startsWith('*** End Patch')) {
      op = close(op);
    } else if (op && line.startsWith(MOVE)) {
      op.movePath = line.slice(MOVE.length).trim();
    } else if (op && op.kind !== 'delete' && !line.startsWith('*** ')) {
      if (line.startsWith('@@')) op.hunks.push([]);
      else if (isChangeLine(line)) op.hunks[op.hunks.length - 1].push(line);
      else if (line === '' && op.kind === 'update') op.hunks[op.hunks.length - 1].push(' ');
    }
  }
  close(op);
  return ops;
}
