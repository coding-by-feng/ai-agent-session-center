/**
 * editDiff.ts — what a chat edit row expands to (AASC-41): the per-file hunks of
 * one edit call, drawn from the call's own input, as the Changes view's server
 * side does (server/chat/diffHunks.ts) but for a single call.
 *
 *   Claude  Edit (old → new), MultiEdit (each edit), Write (all added),
 *           NotebookEdit (the new cell source)
 *   Codex   apply_patch as patch text (`*** Update File: …`) or as a FileChange
 *           map (`{ changes: { path: { type, unified_diff | content } } }`)
 *
 * A phone may get a secret file's edit as `{ file_path, redacted: true }` (or
 * `{ redacted: true, paths }` for a patch): the file is listed, no lines are.
 *
 * Diffs are cached per input object: the chat store keeps entry objects across
 * refreshes, so a long session never diffs the same edit twice.
 */
import { parsePatch, structuredPatch } from 'diff';
import type { DiffHunk } from '@/types/chat';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface EditFile {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** The hunks carry real line numbers. */
  positionKnown: boolean;
  created?: boolean;
  deleted?: boolean;
  /** Phones never see a secret file's content (server/mobile/phoneChatFilter.ts). */
  redacted?: boolean;
}

export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

export const isEditTool = (name: string): boolean => EDIT_TOOL_NAMES.has(name);

const isChangeLine = (line: string): boolean => line[0] === ' ' || line[0] === '+' || line[0] === '-';

function counted(hunks: DiffHunk[]): { added: number; removed: number } {
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

function file(path: string, hunks: DiffHunk[], positionKnown: boolean, extra: Partial<EditFile> = {}): EditFile {
  return { path, hunks, ...counted(hunks), positionKnown, ...extra };
}

/** The lines of some content (a last newline ends the last line, it doesn't start one). */
function contentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function allAdded(content: string, whereKnown = true): DiffHunk[] {
  const lines = contentLines(content);
  return lines.length === 0 ? [] : [{ oldStart: 0, oldLines: 0, newStart: whereKnown ? 1 : 0, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
}

function allRemoved(content: string): DiffHunk[] {
  const lines = contentLines(content);
  return lines.length === 0 ? [] : [{ oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) }];
}

const withEol = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** Past this many edits or this long, two texts show as a rewrite (a phone must not stall). */
const DIFF_MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 50;

/** Two versions of an edited piece of a file; where in the file isn't known, so starts are 0. */
function snippetHunks(before: string, after: string): DiffHunk[] {
  const patch = structuredPatch('a', 'b', withEol(before), withEol(after), '', '', {
    context: 3,
    maxEditLength: DIFF_MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!patch) {
    const removed = contentLines(before).map((l) => `-${l}`);
    const added = contentLines(after).map((l) => `+${l}`);
    return [{ oldStart: 0, oldLines: removed.length, newStart: 0, newLines: added.length, lines: [...removed, ...added] }];
  }
  return patch.hunks.map((h) => ({ ...h, oldStart: 0, newStart: 0, lines: h.lines.filter(isChangeLine) }));
}

function unifiedHunks(text: string): DiffHunk[] {
  try {
    return parsePatch(text).flatMap((f) => f.hunks.map((h) => ({ ...h, lines: h.lines.filter(isChangeLine) })));
  } catch {
    return [];
  }
}

// ── Codex apply_patch text ───────────────────────────────────────────────────

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

/** The file operations of an `apply_patch` patch (the same reading as server/chat/diffHunks.ts). */
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

function patchFiles(input: unknown): EditFile[] {
  if (typeof input === 'string') {
    return parseApplyPatch(input).map((op) => file(op.movePath || op.path, op.hunks, false, {
      ...(op.kind === 'add' ? { created: true } : {}),
      ...(op.kind === 'delete' ? { deleted: true } : {}),
    }));
  }
  if (!isRec(input) || !isRec(input.changes)) return [];
  const out: EditFile[] = [];
  for (const [path, change] of Object.entries(input.changes)) {
    if (!isRec(change)) continue;
    if (change.type === 'add') out.push(file(path, allAdded(str(change.content)), true, { created: true }));
    else if (change.type === 'delete') out.push(file(path, allRemoved(str(change.content)), true, { deleted: true }));
    else out.push(file(str(change.move_path) || path, unifiedHunks(str(change.unified_diff)), true));
  }
  return out;
}

// ── Claude ───────────────────────────────────────────────────────────────────

function claudeFiles(name: string, input: Rec): EditFile[] {
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (!path) return [];
  switch (name) {
    case 'Edit':
      return [file(path, snippetHunks(str(input.old_string), str(input.new_string)), false)];
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRec) : [];
      return [file(path, edits.flatMap((e) => snippetHunks(str(e.old_string), str(e.new_string))), false)];
    }
    case 'Write':
      return [file(path, allAdded(str(input.content), false), false)];
    case 'NotebookEdit':
      return [file(path, input.edit_mode === 'delete' ? [] : allAdded(str(input.new_source), false), false)];
    default:
      return [];
  }
}

function redactedFiles(input: Rec): EditFile[] {
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : [str(input.file_path) || str(input.notebook_path) || str(input.path)].filter(Boolean);
  return paths.map((path) => ({ path, hunks: [], added: 0, removed: 0, positionKnown: false, redacted: true }));
}

function compute(name: string, input: unknown): EditFile[] {
  if (isRec(input) && input.redacted === true) return redactedFiles(input);
  if (name === 'apply_patch') return patchFiles(input);
  return isRec(input) ? claudeFiles(name, input) : [];
}

const cache = new WeakMap<object, EditFile[]>();

/** The files one edit call changed, with their hunks; [] for anything that isn't a readable edit. */
export function editFiles(name: string, input: unknown): EditFile[] {
  if (!isEditTool(name)) return [];
  if (!input || typeof input !== 'object') return compute(name, input);
  const hit = cache.get(input);
  if (hit) return hit;
  const files = compute(name, input);
  cache.set(input, files);
  return files;
}

export function editTotals(files: readonly EditFile[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}
