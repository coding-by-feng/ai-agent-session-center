/**
 * @module transcriptWatch
 * Tells the phone the moment a session's conversation grows (Oct 22 2026).
 *
 * The phone chat used to re-read only when a hook moved the session, or on an 8 s poll while it
 * worked: Claude's prose between tool calls, its thinking and a tool result written after its
 * PostToolUse hook carry no hook of their own, so they showed up to 8 s after the terminal had
 * them. Each chat read (`GET /sessions/:id/chat`) now `touch`es the file it read: the file is
 * watched for `LEASE_MS`, renewed by every later read, and a change of its size calls `onGrow`
 * (coalesced over `COALESCE_MS`). Only chats someone is reading are watched, at most `MAX_FILES`
 * (the one whose lease ends first makes room). A watcher that fails or sees the file replaced
 * is dropped; the phone's next read, which its hooks and poll still cause, watches it again.
 */
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import log from '../logger.js';

export const LEASE_MS = 60_000;
export const COALESCE_MS = 100;
export const MAX_FILES = 8;

export interface FileWatcher {
  close(): void;
}

export interface TranscriptWatchOptions {
  /** A watched session's transcript changed size. */
  onGrow(sessionId: string): void;
  leaseMs?: number;
  coalesceMs?: number;
  maxFiles?: number;
  /** `fs.watch`, swappable in tests. `listener` gets 'change' or 'rename'; `onError` a failure. */
  watch?(path: string, listener: (event: string) => void, onError: (err: unknown) => void): FileWatcher;
  /** The file's size, or null when it cannot be read. */
  sizeOf?(path: string): Promise<number | null>;
}

export interface TranscriptWatch {
  /** A chat read `path` for `sessionId`: watch it (or keep watching) for another lease. */
  touch(sessionId: string, path: string): void;
  /** The sessions being watched (tests). */
  watched(): string[];
  /** Stop every watcher (shutdown). */
  close(): void;
}

interface Entry {
  path: string;
  watcher: FileWatcher;
  size: number | null;
  expiresAt: number;
  lease: ReturnType<typeof setTimeout>;
  pending: ReturnType<typeof setTimeout> | null;
}

function defaultWatch(path: string, listener: (event: string) => void, onError: (err: unknown) => void): FileWatcher {
  const watcher = fsWatch(path, { persistent: false }, (event) => listener(event));
  watcher.on('error', onError);
  return watcher;
}

async function defaultSizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

const unref = (timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

export function createTranscriptWatch(options: TranscriptWatchOptions): TranscriptWatch {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const watchFile = options.watch ?? defaultWatch;
  const sizeOf = options.sizeOf ?? defaultSizeOf;
  const entries = new Map<string, Entry>();

  function drop(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    clearTimeout(entry.lease);
    if (entry.pending) clearTimeout(entry.pending);
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
  }

  async function check(sessionId: string, entry: Entry): Promise<void> {
    const size = await sizeOf(entry.path);
    if (entries.get(sessionId) !== entry || size === null || size === entry.size) return;
    entry.size = size;
    options.onGrow(sessionId);
  }

  function onEvent(sessionId: string, event: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    // A replaced file is a different inode: this watcher will hear nothing more from it.
    if (event === 'rename') {
      drop(sessionId);
      options.onGrow(sessionId);
      return;
    }
    if (entry.pending) return;
    entry.pending = unref(setTimeout(() => {
      entry.pending = null;
      void check(sessionId, entry);
    }, coalesceMs));
  }

  function start(sessionId: string, path: string): void {
    if (entries.size >= maxFiles) {
      const soonest = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (soonest) drop(soonest[0]);
    }
    let watcher: FileWatcher;
    try {
      watcher = watchFile(
        path,
        (event) => onEvent(sessionId, event),
        (err) => {
          log.debug('chat', `transcript watch failed: ${err instanceof Error ? err.message : String(err)}`);
          drop(sessionId);
        },
      );
    } catch (err) {
      log.debug('chat', `transcript watch not started: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const entry: Entry = {
      path,
      watcher,
      size: null,
      expiresAt: Date.now() + leaseMs,
      lease: unref(setTimeout(() => drop(sessionId), leaseMs)),
      pending: null,
    };
    entries.set(sessionId, entry);
    // The read that touched the file saw it at about this size: only what comes after is news.
    void sizeOf(path).then((size) => {
      if (entries.get(sessionId) === entry && entry.size === null) entry.size = size;
    });
  }

  return {
    touch(sessionId, path) {
      const entry = entries.get(sessionId);
      if (entry && entry.path === path) {
        clearTimeout(entry.lease);
        entry.expiresAt = Date.now() + leaseMs;
        entry.lease = unref(setTimeout(() => drop(sessionId), leaseMs));
        return;
      }
      if (entry) drop(sessionId);
      start(sessionId, path);
    },
    watched: () => [...entries.keys()],
    close() {
      for (const sessionId of [...entries.keys()]) drop(sessionId);
    },
  };
}
