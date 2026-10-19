/**
 * changesStore — what each session edited, as last read (AASC-44): the Changes
 * list per session and the diffs opened from it.
 *
 * A list is read again when asked (the session moved: useSessionChangesTotal) and
 * when a screen opens on one older than a few seconds; overlapping reads share one
 * request. A diff is read when its screen opens and kept as it was (DiffScreen):
 * `fileIndex` shifts when the session edits again, so neither a re-read nor an
 * earlier visit's copy may stand in for it.
 *
 * Plain zustand rather than React Query, so the session screen draws anywhere the
 * phone frame does (the frame's tests mount it without a query client).
 *
 * Hooks: useSessionChanges (the list, read when a screen opens on a stale one),
 * useFileChanges (one diff, read once per visit), useSessionChangesTotal (the segment's
 * "+42 −7", which also re-reads the list a second after the session moves).
 *
 * Phone-only (src/__tests__/phoneChunkBoundary.test.ts).
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useSessionStore } from '@/stores/sessionStore';
import {
  fetchFileChanges,
  fetchSessionChanges,
  type PhoneFileChanges,
  type PhoneSessionChanges,
} from '@/lib/chat/changesApi';

export interface Loaded<T> {
  data: T | null;
  /** The last read failed (data, if any, is the one before). */
  error: string | null;
  loading: boolean;
  at: number;
}

/** Diffs kept at most; the oldest opened go first. */
const MAX_FILES = 24;

interface ChangesState {
  lists: Record<string, Loaded<PhoneSessionChanges>>;
  files: Record<string, Loaded<PhoneFileChanges>>;
  loadList: (sessionId: string) => Promise<void>;
  loadFile: (sessionId: string, fileIndex: number) => Promise<void>;
  clearAll: () => void;
}

export const fileKey = (sessionId: string, fileIndex: number): string => `${sessionId}#${fileIndex}`;

const listReads = new Map<string, Promise<void>>();
const fileReads = new Map<string, Promise<void>>();

const blank = <T,>(): Loaded<T> => ({ data: null, error: null, loading: true, at: 0 });

export const useChangesStore = create<ChangesState>((set) => ({
  lists: {},
  files: {},

  loadList: (sessionId) => {
    const inFlight = listReads.get(sessionId);
    if (inFlight) return inFlight;
    set((s) => ({ lists: { ...s.lists, [sessionId]: { ...(s.lists[sessionId] ?? blank()), loading: true } } }));
    const run = (async () => {
      const result = await fetchSessionChanges(sessionId);
      set((s) => {
        const prior = s.lists[sessionId] ?? blank<PhoneSessionChanges>();
        const next: Loaded<PhoneSessionChanges> = result.ok
          ? { data: result.data, error: null, loading: false, at: Date.now() }
          : { ...prior, error: result.message, loading: false, at: Date.now() };
        return { lists: { ...s.lists, [sessionId]: next } };
      });
    })().finally(() => listReads.delete(sessionId));
    listReads.set(sessionId, run);
    return run;
  },

  loadFile: (sessionId, fileIndex) => {
    const key = fileKey(sessionId, fileIndex);
    const inFlight = fileReads.get(key);
    if (inFlight) return inFlight;
    set((s) => ({ files: { ...s.files, [key]: { ...(s.files[key] ?? blank()), loading: true, error: null } } }));
    const run = (async () => {
      const result = await fetchFileChanges(sessionId, fileIndex);
      set((s) => {
        const next: Loaded<PhoneFileChanges> = result.ok
          ? { data: result.data, error: null, loading: false, at: Date.now() }
          // Never the earlier copy: the same index may name another file by now.
          : { data: null, error: result.message, loading: false, at: Date.now() };
        const files = { ...s.files, [key]: next };
        const keys = Object.keys(files);
        if (keys.length > MAX_FILES) {
          const oldest = keys.filter((k) => k !== key).sort((a, b) => files[a].at - files[b].at);
          for (const k of oldest.slice(0, keys.length - MAX_FILES)) delete files[k];
        }
        return { files };
      });
    })().finally(() => fileReads.delete(key));
    fileReads.set(key, run);
    return run;
  },

  clearAll: () => {
    listReads.clear();
    fileReads.clear();
    set({ lists: {}, files: {} });
  },
}));

/** How old a list may be before a screen opening on it reads it again. */
const LIST_FRESH_MS = 5_000;
/** How soon after the session moves the list is read again. */
const ACTIVITY_DEBOUNCE_MS = 1_000;

export interface ChangesQuery<T> {
  data: T | null;
  /** Nothing to show yet: the first read is under way. */
  isPending: boolean;
  isFetching: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/** The session's Changes list, read when a screen opens on it (unless it is fresh). */
export function useSessionChanges(sessionId: string): ChangesQuery<PhoneSessionChanges> {
  const entry = useChangesStore((s) => s.lists[sessionId]);
  const loadList = useChangesStore((s) => s.loadList);
  useEffect(() => {
    const now = useChangesStore.getState().lists[sessionId];
    if (!now || (!now.loading && Date.now() - now.at > LIST_FRESH_MS)) void loadList(sessionId);
  }, [sessionId, loadList]);
  return {
    data: entry?.data ?? null,
    isPending: !entry || (entry.loading && !entry.data && !entry.error),
    isFetching: !!entry?.loading,
    error: entry?.error ?? null,
    refetch: () => loadList(sessionId),
  };
}

/**
 * One file's diff, read when its screen opens and then kept as it was: a later edit
 * doesn't swap it underneath you. Never served from an earlier visit, because the
 * same index may name another file by now.
 */
export function useFileChanges(sessionId: string, fileIndex: number): ChangesQuery<PhoneFileChanges> {
  const [openedAt] = useState(() => Date.now());
  const entry = useChangesStore((s) => s.files[fileKey(sessionId, fileIndex)]);
  const loadFile = useChangesStore((s) => s.loadFile);
  useEffect(() => {
    void loadFile(sessionId, fileIndex);
  }, [sessionId, fileIndex, loadFile]);
  const fresh = entry && !entry.loading && entry.at >= openedAt ? entry : null;
  return {
    data: fresh?.data ?? null,
    isPending: !fresh,
    isFetching: !!entry?.loading,
    error: fresh?.error ?? null,
    refetch: () => loadFile(sessionId, fileIndex),
  };
}

/** Something that changes when the session may have edited a file. */
function activityKey(sessionId: string): string {
  const s = useSessionStore.getState().sessions.get(sessionId);
  return s ? `${s.status}|${s.totalToolCalls}|${s.toolLog?.length ?? 0}` : '';
}

/**
 * The session's total ("+42 −7" on the Changes segment), or null before it is known
 * or when nothing was edited. Re-reads the list a second after the session moves.
 */
export function useSessionChangesTotal(sessionId: string): { added: number; removed: number; files: number } | null {
  const { data } = useSessionChanges(sessionId);

  useEffect(() => {
    let last = activityKey(sessionId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useSessionStore.subscribe(() => {
      const next = activityKey(sessionId);
      if (next === last) return;
      last = next;
      if (timer) return; // a read is planned: it will see this change too
      timer = setTimeout(() => {
        timer = null;
        void useChangesStore.getState().loadList(sessionId);
      }, ACTIVITY_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  if (!data || (data.total.added === 0 && data.total.removed === 0)) return null;
  return { ...data.total, files: data.files.length };
}
