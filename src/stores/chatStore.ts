/**
 * chatStore — the phone chat's pages of each session's conversation (AASC-41).
 *
 * Per session: the entries held (oldest first, keys unique), the cursors for the
 * page above and for what was written since, the CLI, and where the view was.
 *
 *   open(id)       the newest page (or, already held, a refresh)
 *   loadOlder(id)  the page above the oldest entry held, prepended
 *   refresh(id)    what was written since, appended; asks again while the server
 *                  says there is more; overlapping calls coalesce into one more read
 *
 * A `reset` answer (the transcript changed: a /clear) replaces everything held and
 * bumps `version`; an answer to a request made before that is dropped. A cursor
 * the server refuses (400) reloads the newest page.
 *
 * At most MAX_CHAT_SESSIONS sessions are held, least recently opened dropped first,
 * never one a chat on screen retains (`retainChat`). There is no WebSocket message
 * for the transcript: the chat view calls `refresh` when the session's
 * `session_update` changes (useChatLive).
 *
 * Phone-only (src/__tests__/phoneChunkBoundary.test.ts).
 */
import { create } from 'zustand';
import type { ChatCli, ChatEntry, ChatPage } from '@/types/chat';
import { fetchChatPage, type ApiResult } from '@/lib/chat/chatApi';

export const MAX_CHAT_SESSIONS = 5;
/** Reads one refresh may chain while the server keeps saying "more". */
const MAX_REFRESH_READS = 20;

/** Where a chat's view was, so reopening the session lands on the same spot. */
export interface ChatViewMemory {
  /** The oldest item rendered (null: the newest window). */
  firstKey: string | null;
  /** The item at the top of the screen and how far below the top it sat. */
  anchorKey: string | null;
  anchorOffset: number;
  following: boolean;
}

export interface ChatSessionData {
  status: 'loading' | 'ready' | 'error';
  entries: ChatEntry[];
  before: string | null;
  after: string | null;
  cli: ChatCli | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | null;
  olderError: string | null;
  /** The last refresh failed: what is shown may be behind the Mac. */
  refreshError: string | null;
  /** Bumped when what is held was replaced (a reset). */
  version: number;
  view?: ChatViewMemory;
}

interface ChatState {
  sessions: Record<string, ChatSessionData>;
  open: (sessionId: string) => Promise<void>;
  loadOlder: (sessionId: string) => Promise<void>;
  refresh: (sessionId: string) => Promise<void>;
  rememberView: (sessionId: string, view: ChatViewMemory) => void;
  /** Tests and sign-out: forget everything. */
  clearAll: () => void;
}

const EMPTY: ChatSessionData = {
  status: 'loading',
  entries: [],
  before: null,
  after: null,
  cli: null,
  hasOlder: false,
  loadingOlder: false,
  error: null,
  olderError: null,
  refreshError: null,
  version: 0,
};

// ── Bookkeeping outside the state (never drawn) ──────────────────────────────

/** Least recently opened first. */
let lru: string[] = [];
const retained = new Map<string, number>();
const opening = new Map<string, Promise<void>>();
const refreshing = new Map<string, Promise<void>>();
const refreshAgain = new Set<string>();

/** A chat on screen holds its session against eviction; call the returned function on unmount. */
export function retainChat(sessionId: string): () => void {
  retained.set(sessionId, (retained.get(sessionId) ?? 0) + 1);
  return () => {
    const n = (retained.get(sessionId) ?? 1) - 1;
    if (n <= 0) retained.delete(sessionId);
    else retained.set(sessionId, n);
  };
}

/** `older` before `newer`, without an entry `newer` already has. */
function joined(older: readonly ChatEntry[], newer: readonly ChatEntry[]): ChatEntry[] {
  const seen = new Set(newer.map((e) => e.key));
  const head = older.filter((e) => !seen.has(e.key));
  return head.length ? [...head, ...newer] : (newer as ChatEntry[]);
}

function appended(held: readonly ChatEntry[], incoming: readonly ChatEntry[]): ChatEntry[] {
  if (incoming.length === 0) return held as ChatEntry[];
  const seen = new Set(held.map((e) => e.key));
  const fresh = incoming.filter((e) => !seen.has(e.key));
  return fresh.length ? [...held, ...fresh] : (held as ChatEntry[]);
}

export const useChatStore = create<ChatState>((set, get) => {
  const patch = (sessionId: string, change: Partial<ChatSessionData>) =>
    set((s) => {
      const current = s.sessions[sessionId];
      if (!current) return s;
      return { sessions: { ...s.sessions, [sessionId]: { ...current, ...change } } };
    });

  /** Move to most recent; drop the least recent beyond the cap (never one on screen). */
  const touch = (sessionId: string) => {
    lru = [...lru.filter((id) => id !== sessionId), sessionId];
    const drop: string[] = [];
    for (const id of lru) {
      if (lru.length - drop.length <= MAX_CHAT_SESSIONS) break;
      if (id !== sessionId && !retained.has(id)) drop.push(id);
    }
    if (drop.length === 0) return;
    lru = lru.filter((id) => !drop.includes(id));
    set((s) => {
      const sessions = { ...s.sessions };
      for (const id of drop) delete sessions[id];
      return { sessions };
    });
  };

  /** The newest page, replacing whatever is held. */
  const loadNewest = (sessionId: string, keepView: boolean): Promise<void> => {
    const inFlight = opening.get(sessionId);
    if (inFlight) return inFlight;
    const prior = get().sessions[sessionId];
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: prior
          ? { ...prior, status: prior.status === 'ready' ? 'ready' : 'loading', error: null }
          : { ...EMPTY },
      },
    }));
    const run = (async () => {
      const result = await fetchChatPage(sessionId);
      const now = get().sessions[sessionId];
      if (!now) return; // evicted meanwhile
      if (!result.ok) {
        if (now.status === 'ready') patch(sessionId, { refreshError: result.message });
        else patch(sessionId, { status: 'error', error: result.message });
        return;
      }
      const page = result.data;
      const replaced = now.status === 'ready';
      patch(sessionId, {
        status: 'ready',
        entries: page.entries,
        before: page.before,
        after: page.after,
        cli: page.cli,
        hasOlder: page.hasMore && page.before !== null,
        loadingOlder: false,
        error: null,
        olderError: null,
        refreshError: null,
        version: replaced ? now.version + 1 : now.version,
        ...(keepView ? {} : { view: undefined }),
      });
    })().finally(() => opening.delete(sessionId));
    opening.set(sessionId, run);
    return run;
  };

  /** Apply one `after=` answer; true when the server has more to give right away. */
  const applyAfter = (sessionId: string, version: number, result: ApiResult<ChatPage>): 'more' | 'done' | 'reload' => {
    const now = get().sessions[sessionId];
    if (!now || now.version !== version) return 'done';
    if (!result.ok) {
      if (result.status === 400) return 'reload';
      patch(sessionId, { refreshError: result.message });
      return 'done';
    }
    const page = result.data;
    if (page.reset) {
      patch(sessionId, {
        entries: page.entries,
        before: page.before,
        after: page.after,
        cli: page.cli,
        hasOlder: page.hasMore && page.before !== null,
        loadingOlder: false,
        olderError: null,
        refreshError: null,
        version: now.version + 1,
        view: undefined,
      });
      return 'done';
    }
    patch(sessionId, {
      entries: appended(now.entries, page.entries),
      after: page.after ?? now.after,
      cli: page.cli ?? now.cli,
      refreshError: null,
    });
    return page.hasMore ? 'more' : 'done';
  };

  const refreshOnce = async (sessionId: string): Promise<void> => {
    const held = get().sessions[sessionId];
    if (!held || held.status !== 'ready') return;
    // No cursor yet (no transcript when it opened): try the newest page again.
    if (held.after === null) {
      await loadNewest(sessionId, true);
      return;
    }
    for (let i = 0; i < MAX_REFRESH_READS; i += 1) {
      const now = get().sessions[sessionId];
      if (!now || now.after === null) return;
      const result = await fetchChatPage(sessionId, { after: now.after });
      const outcome = applyAfter(sessionId, now.version, result);
      if (outcome === 'reload') {
        await loadNewest(sessionId, false);
        return;
      }
      if (outcome === 'done') return;
    }
  };

  return {
    sessions: {},

    open: (sessionId) => {
      touch(sessionId);
      const held = get().sessions[sessionId];
      if (held?.status === 'ready') return get().refresh(sessionId);
      return loadNewest(sessionId, true);
    },

    refresh: (sessionId) => {
      const inFlight = refreshing.get(sessionId);
      if (inFlight) {
        refreshAgain.add(sessionId);
        return inFlight;
      }
      const run = (async () => {
        do {
          refreshAgain.delete(sessionId);
          await refreshOnce(sessionId);
        } while (refreshAgain.has(sessionId));
      })().finally(() => refreshing.delete(sessionId));
      refreshing.set(sessionId, run);
      return run;
    },

    loadOlder: async (sessionId) => {
      const held = get().sessions[sessionId];
      if (!held || held.status !== 'ready' || !held.hasOlder || held.loadingOlder || held.before === null) return;
      const { version, before } = held;
      patch(sessionId, { loadingOlder: true, olderError: null });
      const result = await fetchChatPage(sessionId, { before });
      const now = get().sessions[sessionId];
      if (!now || now.version !== version) return;
      if (!result.ok) {
        patch(sessionId, { loadingOlder: false, olderError: result.message });
        return;
      }
      const page = result.data;
      if (page.reset) {
        patch(sessionId, {
          entries: page.entries,
          before: page.before,
          after: page.after,
          hasOlder: page.hasMore && page.before !== null,
          loadingOlder: false,
          version: now.version + 1,
          view: undefined,
        });
        return;
      }
      patch(sessionId, {
        entries: joined(page.entries, now.entries),
        before: page.before,
        hasOlder: page.hasMore && page.before !== null,
        loadingOlder: false,
      });
    },

    rememberView: (sessionId, view) => patch(sessionId, { view }),

    clearAll: () => {
      lru = [];
      opening.clear();
      refreshing.clear();
      refreshAgain.clear();
      set({ sessions: {} });
    },
  };
});
