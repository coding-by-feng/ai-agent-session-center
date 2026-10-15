/**
 * @module changeSet
 * The running tally of what a session edited, one entry per file (AASC-44): counts, hunks (at most
 * 512 KB a file), when it was last edited, and the file's whole content when the transcript shows it
 * (so a later Write can be diffed against it). Lists at most 200 files, newest edit first.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { DiffHunk, FileChanges } from '../../src/types/chat.js';
import { countLines, hunkChars } from './diffHunks.js';

/** Files listed. */
export const MAX_FILES = 200;
/** Characters of hunks kept per file… */
export const MAX_HUNK_CHARS = 512 * 1024;
/** …and for the whole session (a kept tally stays in memory between requests). */
export const MAX_HUNK_CHARS_TOTAL = 32 * 1024 * 1024;
/** A file's content is remembered (for diffing a later Write) only up to this size… */
export const MAX_KNOWN_CONTENT = 1024 * 1024;
/** …and only while all the remembered contents of one session fit in this. */
export const MAX_KNOWN_CONTENT_TOTAL = 8 * 1024 * 1024;

/** One edit to one file. */
export interface FileEdit {
  hunks: DiffHunk[];
  created?: boolean;
  deleted?: boolean;
  replaced?: boolean;
  /** The file's content after this edit: a string when known, null when not, undefined to keep what was known. */
  content?: string | null;
}

interface FileState {
  path: string;
  added: number;
  removed: number;
  lastAt: number;
  seq: number;
  hunks: DiffHunk[];
  hunkChars: number;
  truncated: boolean;
  created: boolean;
  deleted: boolean;
  replaced: boolean;
  content: string | null;
}

export interface ChangesSnapshot {
  /** Newest first, at most MAX_FILES. */
  files: FileChanges[];
  /** Over every edited file, listed or not. */
  total: { added: number; removed: number };
  truncated: boolean;
}

export class ChangeSet {
  private readonly files = new Map<string, FileState>();
  private seq = 0;
  private knownChars = 0;
  private hunkCharsTotal = 0;

  constructor(private readonly projectPath: string) {}

  /** The file an edit names, as an absolute path (a relative one is taken from the project). */
  resolvePath(path: string): string {
    return isAbsolute(path) || !this.projectPath ? path : resolve(this.projectPath, path);
  }

  private display(abs: string): string {
    if (!this.projectPath) return abs;
    const rel = relative(this.projectPath, abs);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
  }

  /** What the transcript showed of the file's content last, or null. */
  contentOf(path: string): string | null {
    return this.files.get(this.resolvePath(path))?.content ?? null;
  }

  has(path: string): boolean {
    return this.files.has(this.resolvePath(path));
  }

  apply(path: string, edit: FileEdit, at: number): void {
    const key = this.resolvePath(path);
    const prev = this.files.get(key);
    const counts = countLines(edit.hunks);
    // The hunk list is this tally's own (snapshots copy it), so it grows in place.
    const hunks = prev?.hunks ?? [];
    let chars = prev?.hunkChars ?? 0;
    let truncated = prev?.truncated ?? false;
    for (const hunk of edit.hunks) {
      const size = hunkChars(hunk);
      if (truncated || chars + size > MAX_HUNK_CHARS || this.hunkCharsTotal + size > MAX_HUNK_CHARS_TOTAL) {
        truncated = true;
        continue;
      }
      hunks.push(hunk);
      chars += size;
      this.hunkCharsTotal += size;
    }
    const content = this.remember(prev?.content ?? null, edit.content === undefined ? prev?.content ?? null : edit.content);
    this.files.set(key, {
      path: this.display(key),
      added: (prev?.added ?? 0) + counts.added,
      removed: (prev?.removed ?? 0) + counts.removed,
      lastAt: Math.max(prev?.lastAt ?? 0, at),
      seq: ++this.seq,
      hunks,
      hunkChars: chars,
      truncated,
      created: prev ? prev.created : edit.created === true,
      deleted: edit.deleted === true,
      replaced: (prev?.replaced ?? false) || edit.replaced === true,
      content,
    });
  }

  /** The content to keep for a file (null when too big for the file or session budget). */
  private remember(prev: string | null, next: string | null): string | null {
    this.knownChars -= prev?.length ?? 0;
    if (next === null || next.length > MAX_KNOWN_CONTENT || this.knownChars + next.length > MAX_KNOWN_CONTENT_TOTAL) return null;
    this.knownChars += next.length;
    return next;
  }

  get size(): number {
    return this.files.size;
  }

  snapshot(): ChangesSnapshot {
    const all = [...this.files.values()].sort((a, b) => b.lastAt - a.lastAt || b.seq - a.seq);
    const total = all.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
    const files = all.slice(0, MAX_FILES).map((f): FileChanges => ({
      path: f.path,
      added: f.added,
      removed: f.removed,
      lastAt: f.lastAt,
      hunks: [...f.hunks],
      ...(f.created ? { created: true } : {}),
      ...(f.deleted ? { deleted: true } : {}),
      ...(f.replaced ? { replaced: true } : {}),
      ...(f.truncated ? { truncated: true } : {}),
    }));
    return { files, total, truncated: all.length > MAX_FILES };
  }
}
