/**
 * scrollbackStore — each session's terminal output kept across a server restart (Nov 25 2026).
 *
 * The replay ring (`ptyRing.ts`) lives in memory, so a desktop restart lost every terminal's
 * screen: the restore's `clear-all` found no terminals and logged "0 output buffers saved", and
 * each card stayed blank until its `claude --resume` reprinted part of its history. Now the
 * server writes each live ring here as it shuts down, and `clearAllSessions` hands a saved ring
 * back (as one of its `savedOutputs`) for a session that has no terminal yet, so the restore's
 * existing prefill shows the old screen at once.
 *
 * One file per session, `<sessionId>.bin`, the ring's raw bytes. Terminal output can hold
 * secrets: the folder is 0700, each file 0600, written to a temp name and renamed. A file is
 * read once (`take` deletes it), dropped when its session is killed or closed (`forget`), and a
 * shutdown removes the files of sessions the server no longer has. Nothing is written on a
 * crash: only a clean quit saves.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import log from './logger.js';
import { hookQueueDir } from './hookQueueDir.js';

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SUFFIX = '.bin';

export interface ScrollbackEntry {
  sessionId: string;
  data: Buffer;
}

export interface ScrollbackStore {
  /** Write every entry; delete the files of sessions in neither `entries` nor `keepIds`. Synchronous: runs at shutdown. */
  saveAll(entries: readonly ScrollbackEntry[], keepIds: Iterable<string>): number;
  /** The saved bytes for a session, deleting the file. Null when there are none. */
  take(sessionId: string): Buffer | null;
  /** Delete a session's saved bytes, if any. */
  forget(sessionId: string): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createScrollbackStore(dir: string): ScrollbackStore {
  const fileOf = (sessionId: string): string | null =>
    SAFE_ID_RE.test(sessionId) ? join(dir, `${sessionId}${SUFFIX}`) : null;

  function unlinkQuiet(path: string): void {
    try { unlinkSync(path); } catch { /* already gone */ }
  }

  function saveAll(entries: readonly ScrollbackEntry[], keepIds: Iterable<string>): number {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err: unknown) {
      log.warn('scrollback', `Could not create ${dir}: ${errText(err)}`);
      return 0;
    }
    let saved = 0;
    const written = new Set<string>();
    for (const { sessionId, data } of entries) {
      const file = fileOf(sessionId);
      if (!file || data.length === 0) continue;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, data, { mode: 0o600 });
        renameSync(tmp, file);
        written.add(sessionId);
        saved++;
      } catch (err: unknown) {
        unlinkQuiet(tmp);
        log.warn('scrollback', `Could not save the output of ${sessionId.slice(0, 8)}: ${errText(err)}`);
      }
    }
    const keep = new Set([...keepIds, ...written]);
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(SUFFIX)) continue;
        if (!keep.has(name.slice(0, -SUFFIX.length))) unlinkQuiet(join(dir, name));
      }
    } catch { /* best effort */ }
    return saved;
  }

  function take(sessionId: string): Buffer | null {
    const file = fileOf(sessionId);
    if (!file || !existsSync(file)) return null;
    try {
      const data = readFileSync(file);
      unlinkQuiet(file);
      return data.length > 0 ? data : null;
    } catch (err: unknown) {
      log.warn('scrollback', `Could not read the saved output of ${sessionId.slice(0, 8)}: ${errText(err)}`);
      return null;
    }
  }

  function forget(sessionId: string): void {
    const file = fileOf(sessionId);
    if (file) unlinkQuiet(file);
  }

  return { saveAll, take, forget };
}

/** Beside `sessions-snapshot.json` (sessionStore.ts SNAPSHOT_DIR). */
const SCROLLBACK_DIR = process.env.AASC_SCROLLBACK_DIR
  || join(process.env.APP_USER_DATA ? join(process.env.APP_USER_DATA, 'data') : hookQueueDir(), 'scrollback');

export const scrollbackStore: ScrollbackStore = createScrollbackStore(SCROLLBACK_DIR);
