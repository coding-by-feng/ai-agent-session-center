/**
 * useChatScroll — the phone chat's window over its rows and where it scrolls
 * (AASC-41). No virtual-list library: a long session renders only its newest rows,
 * and earlier ones are added above as you scroll up, the page held still.
 *
 * - Window: the rows from `firstKey` to the end; with no `firstKey`, the newest 60.
 *   Near the top, 24 more rows go above (from memory, else the store's next page);
 *   the row at the top of the screen keeps its place (an anchor measured before
 *   and restored after the prepend).
 * - Follow: at the bottom the view stays pinned as rows arrive (and as rows above
 *   change size). Scrolled up, it stays put and `unseen` says rows arrived below.
 * - Reveal: a search match is brought into the window, then centred.
 * - Memory: where the view was is handed back on unmount, for the next visit.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatItem } from '@/lib/chat/buildChatItems';
import type { ChatViewMemory } from '@/stores/chatStore';

export const INITIAL_WINDOW = 60;
export const WINDOW_STEP = 24;
/** Closer than this to the top, earlier rows are added. */
const NEAR_TOP_PX = 800;
/** Within this of the bottom counts as "at the bottom". */
const FOLLOW_SLACK_PX = 72;

/** A row by its key (keys are `<offset>:<index>` or `queued:<id>`: quotes and backslashes escaped anyway). */
export function rowSelector(key: string): string {
  return `[data-chat-key="${key.replace(/["\\]/g, '\\$&')}"]`;
}

/** The row holding `key` (a folded group holds its calls' keys too), or -1. */
export function indexOfKey(items: readonly ChatItem[], key: string): number {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.key === key) return i;
    if (item.kind === 'tool-group' && item.members.some((m) => m.key === key)) return i;
  }
  return -1;
}

/** The newest transcript row (queued prompts sit after it and aren't activity). */
const tailOf = (items: readonly ChatItem[]): string => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== 'queued') return `${i}|${item.key}|${item.sig}`;
  }
  return '';
};

export interface ChatScrollOptions {
  items: ChatItem[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The last "Load earlier" failed: scrolling doesn't retry it, the button does. */
  olderError: string | null;
  loadOlder: () => Promise<void>;
  /** The store's version: a reset drops the window and follows again. */
  version: number;
  initial?: ChatViewMemory;
  onRemember: (view: ChatViewMemory) => void;
}

export interface ChatScroll {
  start: number;
  following: boolean;
  unseen: boolean;
  onScroll: () => void;
  jumpToLatest: () => void;
  /** Add earlier rows (`auto`: from scrolling near the top, which never retries a failed read). */
  showEarlier: (auto?: boolean) => void;
  reveal: (key: string) => void;
}

export function useChatScroll(o: ChatScrollOptions): ChatScroll {
  const { items, scrollerRef, listRef } = o;
  const [firstKey, setFirstKey] = useState<string | null>(o.initial?.firstKey ?? null);
  const [following, setFollowing] = useState(o.initial?.following ?? true);
  const [leftAt, setLeftAt] = useState('');
  const [revealTick, setRevealTick] = useState(0);
  const [seenVersion, setSeenVersion] = useState(o.version);
  if (seenVersion !== o.version) {
    // The transcript was replaced: start again at the newest rows.
    setSeenVersion(o.version);
    setFirstKey(null);
    setFollowing(true);
  }

  const start = useMemo(() => {
    if (firstKey) {
      const at = indexOfKey(items, firstKey);
      if (at >= 0) return at;
    }
    return Math.max(0, items.length - INITIAL_WINDOW);
  }, [items, firstKey]);
  const tail = tailOf(items);
  const unseen = !following && leftAt !== '' && leftAt !== tail;

  // What the handlers read without re-subscribing (kept current after each render).
  const live = useRef({ items, start, firstKey, following, tail, hasOlder: o.hasOlder, loadingOlder: o.loadingOlder, olderError: o.olderError, loadOlder: o.loadOlder });
  const anchor = useRef<{ key: string; offset: number } | null>(
    o.initial?.anchorKey ? { key: o.initial.anchorKey, offset: o.initial.anchorOffset } : null,
  );
  const restorePending = useRef(!!o.initial && !o.initial.following);
  const lastFirstRendered = useRef<string | undefined>(undefined);
  const revealKey = useRef<string | null>(null);
  const olderPending = useRef(false);
  const frame = useRef(0);

  /** The row at the top of the screen and how far below the top it sits. */
  const measureAnchor = useCallback(() => {
    const el = scrollerRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const rows = list.children;
    const top = el.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > top + 1) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const node = found >= 0 ? (rows[found] as HTMLElement) : null;
    const key = node?.dataset.chatKey;
    if (node && key) anchor.current = { key, offset: node.getBoundingClientRect().top - top };
  }, [scrollerRef, listRef]);

  const restoreAnchor = useCallback(() => {
    const el = scrollerRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    const node = listRef.current?.querySelector<HTMLElement>(rowSelector(a.key));
    if (!node) return;
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    if (Math.abs(delta) > 0.5) el.scrollTop += delta;
  }, [scrollerRef, listRef]);

  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollerRef]);

  useLayoutEffect(() => {
    live.current = { items, start, firstKey, following, tail, hasOlder: o.hasOlder, loadingOlder: o.loadingOlder, olderError: o.olderError, loadOlder: o.loadOlder };
    const el = scrollerRef.current;
    const firstRendered = items[start]?.key;
    if (el && revealKey.current) {
      const node = listRef.current?.querySelector<HTMLElement>(rowSelector(revealKey.current));
      revealKey.current = null;
      if (node) {
        const box = el.getBoundingClientRect();
        const r = node.getBoundingClientRect();
        el.scrollTop += r.top - box.top - Math.max(64, (box.height - r.height) / 2);
        measureAnchor();
      }
    } else if (following) {
      pinToBottom();
    } else if (restorePending.current || (lastFirstRendered.current !== undefined && firstRendered !== lastFirstRendered.current)) {
      // Rows went in above (or this is a return visit): hold the top row where it was.
      restoreAnchor();
    }
    restorePending.current = false;
    lastFirstRendered.current = firstRendered;
  }, [items, start, firstKey, following, tail, revealTick, o.hasOlder, o.loadingOlder, o.olderError, o.loadOlder, scrollerRef, listRef, measureAnchor, restoreAnchor, pinToBottom]);

  // Rows that change size later (Markdown loading, an image), and a scroller that
  // shrinks (the strip grows, the composer or the keyboard arrives), keep the bottom pinned.
  useEffect(() => {
    const list = listRef.current;
    const el = scrollerRef.current;
    if (!list || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (live.current.following) pinToBottom();
    });
    ro.observe(list);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listRef, scrollerRef, pinToBottom]);

  const showEarlier = useCallback((auto = false) => {
    const cur = live.current;
    if (cur.start > 0) {
      measureAnchor();
      setFirstKey(cur.items[Math.max(0, cur.start - WINDOW_STEP)].key);
      return;
    }
    if (!cur.hasOlder || cur.loadingOlder || olderPending.current || (auto && cur.olderError)) return;
    olderPending.current = true;
    // Hold the window where it is while the page comes, then grow it upward.
    if (cur.firstKey === null && cur.items[0]) setFirstKey(cur.items[0].key);
    void cur.loadOlder().finally(() => {
      olderPending.current = false;
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el && el.scrollTop < NEAR_TOP_PX && live.current.start > 0) {
          measureAnchor();
          const now = live.current;
          setFirstKey(now.items[Math.max(0, now.start - WINDOW_STEP)].key);
        }
      });
    });
  }, [measureAnchor, scrollerRef]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    const cur = live.current;
    if (atBottom !== cur.following) {
      cur.following = atBottom;
      setFollowing(atBottom);
      if (!atBottom) {
        setLeftAt(cur.tail);
        // Stop the window sliding while you read.
        if (cur.firstKey === null && cur.items[cur.start]) setFirstKey(cur.items[cur.start].key);
      }
    }
    if (!atBottom && el.scrollTop < NEAR_TOP_PX) showEarlier(true);
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        measureAnchor();
      });
    }
  }, [scrollerRef, showEarlier, measureAnchor]);

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const jumpToLatest = useCallback(() => {
    live.current.following = true;
    setFirstKey(null);
    setFollowing(true);
  }, []);

  const reveal = useCallback((key: string) => {
    const cur = live.current;
    const at = indexOfKey(cur.items, key);
    if (at < 0) return;
    revealKey.current = cur.items[at].key;
    if (at < cur.start) setFirstKey(cur.items[Math.max(0, at - 2)].key);
    if (cur.following) {
      cur.following = false;
      setFollowing(false);
      setLeftAt(cur.tail);
    }
    setRevealTick((t) => t + 1);
  }, []);

  // Hand back where the view was (measured while the rows are still there).
  const remember = useRef(o.onRemember);
  useLayoutEffect(() => {
    remember.current = o.onRemember;
  }, [o.onRemember]);
  useLayoutEffect(() => () => {
    measureAnchor();
    const cur = live.current;
    remember.current({
      firstKey: cur.firstKey,
      anchorKey: anchor.current?.key ?? null,
      anchorOffset: anchor.current?.offset ?? 0,
      following: cur.following,
    });
  }, [measureAnchor]);

  return { start, following, unseen, onScroll, jumpToLatest, showEarlier, reveal };
}
