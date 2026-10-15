/**
 * @module transcriptPager
 * Pages of chat entries from a JSONL transcript, read from a byte cursor and never whole (AASC-41).
 *
 * Transcripts get big (Claude's run to tens of MB, a Codex rollout to 28 MB was seen), so a call reads
 * at most `scanBytes` (4 MB) and stops at `limit` (200) entries:
 *  - no cursor   the newest page, read backwards from the end;
 *  - `before`    the page above an earlier page (older entries);
 *  - `after`     what was written since (newer entries), for a live view.
 *
 * Only whole lines are read. A last line still being written (no newline yet, and not a complete JSON
 * record) is left for the next call, so `after` never skips past half a record.
 *
 * Cursors are opaque `<file tag>:<offset>` strings. The tag (inode + a hash of the path) ties a
 * cursor to one file: a cursor from another file (a `/clear` began a new transcript) or past the end
 * of this one gives the newest page with `reset: true` rather than entries read from the middle of a
 * line. (Not the birth time: where a filesystem has none, Node reports the change time, which moves
 * on every append.)
 */
import { open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ChatEntry } from '../../src/types/chat.js';
import { foldCommandOutput, type ChatEntryDraft } from './chatEntries.js';

/** Entries in one page (a record's entries are never split, so a page can run a little over). */
export const PAGE_ENTRIES = 200;
/** Bytes one call may scan. */
export const SCAN_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;
const CHUNK = 64 * 1024;

/** How one CLI's records become chat entries. */
export interface LineReader {
  /** The entries a parsed record holds (none for bookkeeping records). `offset`: where its line starts. */
  entries(record: unknown, ctx: { offset: number }): ChatEntryDraft[];
  /** The record's own time in epoch ms, or NaN when it has none. */
  timestamp(record: unknown): number;
}

export interface PageOptions {
  before?: string;
  after?: string;
  limit?: number;
  scanBytes?: number;
}

export interface TranscriptPage {
  entries: ChatEntry[];
  before: string;
  after: string;
  hasMore: boolean;
  reset?: true;
}

/** A `before` / `after` value this pager never handed out. */
export class CursorError extends Error {}

const CURSOR_RE = /^([0-9a-z]{1,16}-[0-9a-z]{1,16}):(\d{1,15})$/;

/** FNV-1a of a string: a short, stable hash for the cursor's file tag. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function fileTag(file: string, st: Stats): string {
  return `${st.ino.toString(36)}-${fnv1a(file).toString(36)}`;
}

function parseCursor(raw: string): { tag: string; offset: number } {
  const m = CURSOR_RE.exec(raw);
  if (!m) throw new CursorError('Not a chat cursor');
  return { tag: m[1], offset: Number(m[2]) };
}

async function readRange(fh: FileHandle, from: number, to: number): Promise<Buffer> {
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

function parseRecord(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Offset of the last newline before `end`, or -1. Reads backwards in chunks, holding none of them. */
async function lastNewlineBefore(fh: FileHandle, end: number, floor = 0): Promise<number> {
  let to = end;
  while (to > floor) {
    const from = Math.max(floor, to - CHUNK);
    const nl = (await readRange(fh, from, to)).lastIndexOf(NEWLINE);
    if (nl >= 0) return from + nl;
    to = from;
  }
  return -1;
}

/** Offset of the first newline at or after `from`, or -1. */
async function nextNewlineFrom(fh: FileHandle, from: number, size: number): Promise<number> {
  for (let at = from; at < size; at += CHUNK) {
    const nl = (await readRange(fh, at, Math.min(size, at + CHUNK))).indexOf(NEWLINE);
    if (nl >= 0) return at + nl;
  }
  return -1;
}

/**
 * Where the readable part of the file ends: its size, or the start of a last line still being
 * written. A last line without a newline counts when it is a complete JSON record.
 */
async function readableEnd(fh: FileHandle, size: number, scanBytes: number): Promise<number> {
  if (size === 0) return 0;
  if ((await readRange(fh, size - 1, size))[0] === NEWLINE) return size;
  // A last line longer than the budget is skipped like any other (its start isn't even looked for).
  const floor = Math.max(0, size - scanBytes - 1);
  const nl = await lastNewlineBefore(fh, size, floor);
  if (nl < 0 && floor > 0) return floor;
  const tailStart = nl + 1;
  const record = parseRecord((await readRange(fh, tailStart, size)).toString('utf8'));
  return record !== null && typeof record === 'object' ? size : tailStart;
}

interface Line {
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
function splitLines(buf: Buffer, base: number, startsAtLine: boolean): Line[] {
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

/** Keys, times and folded command output for records in file order. */
function toEntries(reader: LineReader, records: ReadonlyArray<{ offset: number; record: unknown }>): ChatEntry[] {
  const out: ChatEntry[] = [];
  let lastTs = 0;
  for (const { offset, record } of records) {
    const own = reader.timestamp(record);
    const timestamp = Number.isFinite(own) ? own : lastTs;
    lastTs = timestamp;
    reader.entries(record, { offset }).forEach((draft, i) => {
      out.push({ ...draft, key: `${offset}:${i}`, timestamp } as ChatEntry);
    });
  }
  return foldCommandOutput(out);
}

const nonEmpty = (text: string): boolean => text.trim() !== '';

async function backwardPage(
  fh: FileHandle,
  reader: LineReader,
  end: number,
  limit: number,
  scanBytes: number,
): Promise<{ entries: ChatEntry[]; start: number }> {
  const base = Math.max(0, end - scanBytes);
  const lines = splitLines(await readRange(fh, base, end), base, base === 0).filter((l) => nonEmpty(l.text));
  const records: Array<{ offset: number; record: unknown }> = [];
  let count = 0;
  let first = lines.length;
  while (first > 0 && count < limit) {
    first -= 1;
    const record = parseRecord(lines[first].text);
    records.unshift({ offset: lines[first].offset, record });
    count += reader.entries(record, { offset: lines[first].offset }).length;
  }
  // A window with no line start in it (one line longer than the budget) still moves the next page back.
  const start = first < lines.length ? lines[first].offset : base;
  return { entries: toEntries(reader, records), start };
}

async function forwardPage(
  fh: FileHandle,
  reader: LineReader,
  from: number,
  end: number,
  limit: number,
  scanBytes: number,
): Promise<{ entries: ChatEntry[]; after: number }> {
  const stop = Math.min(end, from + scanBytes);
  // Inside the readable end every line is whole; at a budget cut the last one may not be.
  const lines = splitLines(await readRange(fh, from, stop), from, true).filter((l) => l.complete || stop === end);
  if (lines.length === 0 && stop < end) {
    // One line longer than the whole budget: step over it.
    const nl = await nextNewlineFrom(fh, stop, end);
    return { entries: [], after: nl < 0 ? end : nl + 1 };
  }
  const records: Array<{ offset: number; record: unknown }> = [];
  let count = 0;
  let after = from;
  for (const line of lines) {
    if (count >= limit) break;
    after = line.next;
    if (!nonEmpty(line.text)) continue;
    const record = parseRecord(line.text);
    records.push({ offset: line.offset, record });
    count += reader.entries(record, { offset: line.offset }).length;
  }
  return { entries: toEntries(reader, records), after };
}

/** One page of chat entries from `file`. Throws CursorError for a malformed cursor. */
export async function readChatPage(file: string, reader: LineReader, opts: PageOptions = {}): Promise<TranscriptPage> {
  const limit = opts.limit ?? PAGE_ENTRIES;
  const scanBytes = opts.scanBytes ?? SCAN_BYTES;
  const raw = opts.before ?? opts.after;
  const cursor = raw === undefined ? null : parseCursor(raw);
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    const tag = fileTag(file, st);
    const end = await readableEnd(fh, st.size, scanBytes);
    const at = (offset: number) => `${tag}:${offset}`;

    const stale = cursor !== null && (cursor.tag !== tag || cursor.offset > end);
    if (cursor && !stale && opts.after !== undefined) {
      const page = await forwardPage(fh, reader, cursor.offset, end, limit, scanBytes);
      return { entries: page.entries, before: at(cursor.offset), after: at(page.after), hasMore: page.after < end };
    }
    const from = cursor && !stale ? cursor.offset : end;
    const page = await backwardPage(fh, reader, from, limit, scanBytes);
    return {
      entries: page.entries,
      before: at(page.start),
      after: at(from),
      hasMore: page.start > 0,
      ...(stale ? { reset: true as const } : {}),
    };
  } finally {
    await fh.close();
  }
}
