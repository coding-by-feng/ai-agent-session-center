/**
 * useSessionStrip — the session list the strip shows, read from the stores:
 * the numbered order, the room filter, the PINNED and RECENT frames and the
 * frames of the chosen view (lib/sessionStrip.ts). Desktop only: SessionSwitcher
 * is the one caller (the classic phone drawer went in AASC-48), and PINNED
 * (`showPinned`) is the desktop strip's. The phone app's Sessions list calls
 * buildStripItems itself, without it.
 *
 * useCompletionAttention — which sessions finished a turn while you were
 * looking at another one (the strip's green ✓, lib/sessionAttention.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import { useCentralSessionsShown } from '@/stores/centralFeatureStore';
import { detectCli } from '@/lib/cliDetect';
import { isListedSession, numberedSessions, sortSessionsByActivity } from '@/lib/sessionSort';
import { pickRecentSessions, RECENT_EXPANDED_LIMIT, RECENT_LIMIT, RECENT_TICK_MS } from '@/lib/recentSessions';
import { buildStripItems, filterByRooms, filterBySearch, type StripItem } from '@/lib/sessionStrip';
import { useLabelStore } from '@/stores/labelStore';
import { nextCompletionAttention } from '@/lib/sessionAttention';
import type { Session } from '@/types';

/**
 * The RECENT frame's session ids, newest work first. Only listed sessions: an AI popup
 * (`isFloating`) belongs to its popup, and listing it left a card behind after the popup
 * was closed, until the CLI's SessionEnd arrived.
 */
export function recentRailIds(sessions: ReadonlyMap<string, Session>, now: number, limit = RECENT_LIMIT): string[] {
  const listed = [...sessions.values()].filter(isListedSession);
  return pickRecentSessions(listed, now, limit).map((s) => s.sessionId);
}

export interface SessionStrip {
  /** Every listed session in strip order (status order; recency in the Recent view). */
  sortedSessions: Session[];
  /** A session's number: its place in the status order, whatever the view. 1-based. */
  sessionIndexMap: Map<string, number>;
  /** The current session's number, or -1 when it is not listed. */
  currentIndex: number;
  /** Ids of the sessions that have not ended. */
  activeSessionIds: Set<string>;
  /** Rooms that hold a live session: the ones the room filter can show. */
  availableRooms: Room[];
  /** What the room filter lets through, in strip order. */
  filteredSessions: Session[];
  /** What the search box then lets through (all of filteredSessions when it is empty). */
  matchedSessions: Session[];
  /** A search is typed: the built-in frames step aside and folded frames open. */
  searching: boolean;
  /** The frames and loose cards, in the order they are drawn. */
  items: StripItem[];
  /** More than `RECENT_LIMIT` sessions qualify for RECENT: its 10 ↔ 20 toggle has something to show. */
  recentHasMore: boolean;
}

export function useSessionStrip(
  sessions: Map<string, Session>,
  currentSessionId: string,
  searchQuery = '',
): SessionStrip {
  const sessionSortMode = useUiStore((s) => s.sessionSortMode);
  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const pinnedRoomHidden = useUiStore((s) => s.pinnedRoomHidden);
  const recentExpanded = useUiStore((s) => s.recentRoomExpanded);
  // No CENTRAL frame while central sessions are off (centralFeatureStore).
  const showCentral = useCentralSessionsShown();
  const rooms = useRoomStore((s) => s.rooms);
  const sortByActivity = sessionSortMode === 'activity';

  // Derive a stable content signature from `sessions`. The Map reference changes
  // on every session update (pattern `new Map(...)`), but if the visible fields
  // haven't changed the downstream memos don't need to rerun.  This moves the
  // O(N) sort + filter off the hot path for ~95% of session-update events.
  //
  // `lastActivityAt` is only part of the signature in activity-sort mode: it
  // ticks on every hook event, so including it always would defeat the gating
  // above — but leaving it out in activity mode would freeze the list, since
  // nothing else changes when a session merely stays busy.
  const sessionsSignature = useMemo(() => {
    const parts: string[] = [];
    sessions.forEach((s) => {
      const activity = sortByActivity ? `|${s.lastActivityAt ?? 0}` : '';
      // projectPath and sshHost are what the Projects view groups by; a session
      // whose directory changes (an SSH session follows its hook's cwd) has to
      // move frames without waiting for some other field to change.
      // pendingProceedAt: the card's P (its answer asks you to proceed) comes and goes with no other change.
      // compacting: so does its spinner, since a compaction leaves the status alone.
      // backgroundTaskCount: so does "working in the background" (a later Stop lists the shells as finished).
      // interruption: so does the usage limit's hourglass, which leaves the status alone too.
      // detectCli: the card's Claude/Codex mark, when the CLI is identified after the card first drew.
      // remark: the search box reads it, and a remark can change from another device with nothing else.
      // pinOrder: a drag in PINNED (here or on another device) moves cards and their numbers, nothing else.
      parts.push(`${s.sessionId}|${s.status}|${s.pendingProceedAt ?? ''}|${s.compacting?.since ?? ''}|${s.backgroundTaskCount ?? 0}|${s.interruption?.kind ?? ''}:${s.interruption?.detectedAt ?? ''}|${detectCli(s) ?? ''}|${s.pinned ? 1 : 0}:${s.pinOrder ?? ''}|${s.title ?? ''}|${s.projectName ?? ''}|${s.projectPath ?? ''}|${s.sshHost ?? ''}|${s.colorIndex ?? ''}|${s.accentColor ?? ''}|${s.terminalId ?? ''}|${s.remark ?? ''}${activity}`);
    });
    parts.sort();
    return parts.join('\n');
  }, [sessions, sortByActivity]);

  // Build the globally indexed session list (all active, sorted). The current
  // session stays IN it: dropping it (the strip began as a "switch to another
  // session" list) also removed any room whose only session was the current
  // one, so the room you were working in vanished from the rail.
  const { sortedSessions, sessionIndexMap, currentIndex } = useMemo(() => {
    // The badge numbers. numberedSessions is shared with Alt+⌘+1…9 and the
    // "go to session #" box, so a number typed is the number shown here.
    const allActive = numberedSessions(sessions.values());
    // The index map is always built from the status ordering above, never from
    // the activity ordering: these numbers are the session's identity in the
    // strip (and in keyboard switching), so flat mode must reorder rows without
    // renumbering them.
    const indexMap = new Map<string, number>();
    let curIdx = -1;
    allActive.forEach((s, i) => {
      indexMap.set(s.sessionId, i + 1);
      if (s.sessionId === currentSessionId) curIdx = i + 1;
    });
    return {
      sortedSessions: sortByActivity ? sortSessionsByActivity(allActive) : allActive,
      sessionIndexMap: indexMap,
      currentIndex: curIdx,
    };
    // `sessionsSignature` covers field changes; `sessions` ref is intentionally
    // excluded so unchanged-content re-renders skip the sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature, currentSessionId, sortByActivity]);

  // ---- Built-in RECENT frame (Rooms and Projects views: each session is also listed in its own room or project) ----
  // Membership depends on the clock as well as on updates: a session leaves
  // RECENT when it has been quiet for the whole window, and no update arrives
  // to say so. The tick re-checks once a minute.
  const [recentNow, setRecentNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setRecentNow(Date.now()), RECENT_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // The RECENT ids in order, as one string. It is rebuilt from the fresh
  // `sessions` on every update and tick, but it only changes when a session
  // joins, leaves or moves, so everything downstream stays put otherwise.
  // 10, or 20 after the frame's toggle. Picked with the real limit, never sliced from the 20: the
  // list is ordered pinned-first after the cut, so its first 10 are not the 10 newest.
  const { recentIdsKey, recentHasMore } = useMemo(() => {
    if (sessionSortMode === 'activity') return { recentIdsKey: '', recentHasMore: false };
    const wide = recentRailIds(sessions, recentNow, RECENT_EXPANDED_LIMIT);
    const hasMore = wide.length > RECENT_LIMIT;
    const ids = recentExpanded || !hasMore ? wide : recentRailIds(sessions, recentNow);
    return { recentIdsKey: ids.join('\n'), recentHasMore: hasMore };
  }, [sessions, sessionSortMode, recentNow, recentExpanded]);

  // Rooms that have at least one session in the current active list
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    sessions.forEach((s) => { if (s.status !== 'ended') ids.add(s.sessionId); });
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature]);
  const availableRooms = useMemo(
    () => rooms.filter((r) => r.sessionIds.some((id) => activeSessionIds.has(id))),
    [rooms, activeSessionIds],
  );

  // Apply the room filter. It treats the current session's card like any other;
  // the header above the strip always shows it.
  const filteredSessions = useMemo(
    () => filterByRooms(sortedSessions, selectedRoomIds, rooms),
    [sortedSessions, selectedRoomIds, rooms],
  );

  // Then the search box, on top of the room filter. A search lists each match
  // once: CENTRAL, PINNED and RECENT only repeat cards that are in a room below.
  const labels = useLabelStore((s) => s.labels);
  const searching = searchQuery.trim() !== '';
  const matchedSessions = useMemo(
    () => filterBySearch(filteredSessions, searchQuery, {
      numberOf: (id) => sessionIndexMap.get(id),
      labelOf: (id) => labels[id],
    }),
    [filteredSessions, searchQuery, sessionIndexMap, labels],
  );

  const items = useMemo(
    () => buildStripItems({
      filtered: matchedSessions,
      all: sortedSessions,
      rooms,
      mode: sessionSortMode,
      recentIds: recentIdsKey && !searching ? recentIdsKey.split('\n') : [],
      showPinned: !pinnedRoomHidden && !searching,
      showCentral: showCentral && !searching,
    }),
    [matchedSessions, sortedSessions, rooms, sessionSortMode, recentIdsKey, pinnedRoomHidden, showCentral, searching],
  );

  return {
    sortedSessions, sessionIndexMap, currentIndex, activeSessionIds, availableRooms,
    filteredSessions, matchedSessions, searching, items, recentHasMore,
  };
}

/**
 * Sessions that finished work (moved to "waiting") while another session was
 * open, and have not been viewed since. Returns the set and `acknowledge(id)`,
 * for the click that opens one. Viewing a session acknowledges it too, however
 * it became current (the sidebar, Cmd+N, Cmd+E, a swipe).
 *
 * Worked out while rendering from the previous session list (kept in state),
 * not in an effect: lib/sessionAttention.ts `nextCompletionAttention` compares
 * each session's status with the one before.
 */
/** Each session's status, and a key that changes only when an id or a status does. */
function statusSnapshot(sessions: Map<string, Session>): { key: string; statuses: Map<string, { status: string }> } {
  const statuses = new Map<string, { status: string }>();
  const parts: string[] = [];
  sessions.forEach((s, id) => {
    statuses.set(id, { status: s.status });
    parts.push(`${id}\u0000${s.status}`);
  });
  return { key: parts.join('\n'), statuses };
}

export function useCompletionAttention(
  sessions: Map<string, Session>,
  currentSessionId: string,
): [ReadonlySet<string>, (id: string) => void] {
  const [tracked, setTracked] = useState(() => ({
    ...statusSnapshot(sessions),
    currentSessionId,
    ids: new Set<string>() as ReadonlySet<string>,
  }));
  let ids = tracked.ids;
  // Only a status change, a session coming or going, or a switch can change the
  // set, so only those store a new snapshot: most session updates (a tool call
  // while working) change none of them and cost no second render.
  const snapshot = statusSnapshot(sessions);
  if (tracked.key !== snapshot.key || tracked.currentSessionId !== currentSessionId) {
    ids = nextCompletionAttention(tracked.ids, tracked.statuses, sessions, currentSessionId);
    setTracked({ ...snapshot, currentSessionId, ids });
  }

  const acknowledge = useCallback((id: string) => {
    setTracked((prev) => {
      if (!prev.ids.has(id)) return prev;
      const next = new Set(prev.ids);
      next.delete(id);
      return { ...prev, ids: next };
    });
  }, []);

  return [ids, acknowledge];
}
