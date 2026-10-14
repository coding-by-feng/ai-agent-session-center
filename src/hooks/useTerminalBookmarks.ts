/**
 * useTerminalBookmarks — a terminal's bookmarks on this device (AASC-20), shared
 * by every component showing that terminal. The list itself and its storage are
 * in lib/terminalBookmarks; this keeps one copy per terminal in memory and tells
 * subscribers when it changes (`useSyncExternalStore`, so no effect sets state).
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  addBookmark,
  loadBookmarks,
  removeBookmark,
  saveBookmarks,
  type TerminalBookmark,
} from '@/lib/terminalBookmarks';

const EMPTY: TerminalBookmark[] = [];
const cache = new Map<string, TerminalBookmark[]>();
const listeners = new Set<() => void>();

function read(terminalId: string): TerminalBookmark[] {
  let list = cache.get(terminalId);
  if (!list) {
    list = loadBookmarks(terminalId);
    cache.set(terminalId, list);
  }
  return list;
}

function write(terminalId: string, list: TerminalBookmark[]): void {
  cache.set(terminalId, list);
  saveBookmarks(terminalId, list);
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

export interface TerminalBookmarks {
  bookmarks: TerminalBookmark[];
  /** Bookmark a line; returns false when there was nothing to keep. */
  add: (line: number, text: string) => boolean;
  remove: (id: string) => void;
}

export function useTerminalBookmarks(terminalId: string | null): TerminalBookmarks {
  const bookmarks = useSyncExternalStore(
    subscribe,
    () => (terminalId ? read(terminalId) : EMPTY),
    () => EMPTY,
  );
  const add = useCallback((line: number, text: string): boolean => {
    if (!terminalId || !text.trim()) return false;
    write(terminalId, addBookmark(read(terminalId), line, text));
    return true;
  }, [terminalId]);
  const remove = useCallback((id: string) => {
    if (terminalId) write(terminalId, removeBookmark(read(terminalId), id));
  }, [terminalId]);
  return { bookmarks, add, remove };
}
