/**
 * ChatView — a session as a conversation on the phone (AASC-41), the Chat segment.
 *
 *   [ search, pulled down over the top when you scroll up ]
 *   Load earlier · Start of the conversation
 *   your prompts (bubbles) · the agent's text (Markdown, whole) · tool rows that
 *   fold and open · edit diffs · thinking · the plan · subagents · dividers
 *   queued prompts, dimmed, with Pull back
 *   [ New activity ↓ ]
 *   ● Working · Bash · 0:42                 ■ Stop      (while it works)
 *   terminal peek                (tap: twelve lines and "Open terminal")
 *
 * Fills the segment panel (`flex: 1; min-height: 0`): the composer and the
 * waiting card mount below the panel as its sibling (AASC-42/43).
 *
 * Data: chatStore pages (the newest first, earlier ones on demand), kept current by
 * useChatLive; rows from buildChatItems; the window and following from
 * useChatScroll. A session with no transcript says so and offers the Terminal.
 * Selecting text offers Ask AI (PhoneConversationAi) and Read aloud.
 */
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import type { Session } from '@/types';
import { useChatStore, type ChatViewMemory } from '@/stores/chatStore';
import { useQueueStore } from '@/stores/queueStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { buildChatItems, findMatches, type ChatItem, type QueuedItem } from '@/lib/chat/buildChatItems';
import { plural } from '@/lib/chat/chatFormat';
import { isCompacting } from '@/lib/chat/phoneStatus';
import { SELECTABLE_ATTR } from '@/lib/aiSelectable';
import { matchesQuery, normalizeQuery } from '@/lib/textHighlight';
import { showToast } from '@/components/ui/ToastContainer';
import { Button, EmptyState, useScreenSlot } from '../kit';
import ChatItemView from './items/ChatItemView';
import ChatSearchBar from './ChatSearchBar';
import StatusStrip from './StatusStrip';
import SelectionReadAloud from './SelectionReadAloud';
import { useChatLive } from './useChatLive';
import { useChatScroll } from './useChatScroll';
import { useSearchHighlight } from './useSearchHighlight';
import { useTerminalPeek } from './useTerminalPeek';
import { ArrowDownIcon } from './chatViewIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

const PhoneConversationAi = lazy(() => import('../PhoneConversationAi'));

export interface ChatViewProps {
  session: Session;
  /** Open the session's terminal (a screen pushed over the chat, AASC-56). */
  onTerminal: () => void;
  /** Take a queued prompt back (default: out of the queue, into the composer's draft). */
  onPullBack?: (item: QueuedItem) => void;
  /**
   * This chat is an AI popup's answer (AASC-57): Ask AI forks the popup (its terminal)
   * but shows the new popup under the root session, and the empty state speaks of the answer.
   */
  popup?: { rootSessionId: string; terminalId: string };
}

const EMPTY_QUEUE: never[] = [];

/** Rows open by default: the newest plan, and a plan the agent proposes. */
const openByDefault = (item: ChatItem): boolean =>
  (item.kind === 'todo' && item.latest) || (item.kind === 'tool' && item.call.name === 'ExitPlanMode');

function defaultPullBack(sessionId: string, item: QueuedItem): void {
  useQueueStore.getState().remove(sessionId, item.itemId);
  useComposerDraftStore.getState().appendToDraft(sessionId, item.text);
  showToast(
    item.images > 0
      ? `Moved back to your message. Its ${plural(item.images, 'image')} stayed behind.`
      : 'Moved back to your message.',
    'info',
  );
}

function isWorking(status: string): boolean {
  return status === 'working' || status === 'prompting';
}

/** Waiting on you: its open call waits for an approval or an answer. */
function isAwaiting(status: string): boolean {
  return status === 'approval' || status === 'input';
}

/** The comma-joined keys of a folded group's calls that are open (a cheap memo key). */
function openMembersOf(item: ChatItem, opened: Record<string, boolean>): string | undefined {
  if (item.kind !== 'tool-group') return undefined;
  return item.members.filter((m) => opened[m.key]).map((m) => m.key).join(',');
}

export default function ChatView({ session, onTerminal, onPullBack, popup }: ChatViewProps) {
  const { sessionId } = session;
  useChatLive(session);
  const data = useChatStore((s) => s.sessions[sessionId]);
  const loadOlderAction = useChatStore((s) => s.loadOlder);
  const rememberView = useChatStore((s) => s.rememberView);
  const queue = useQueueStore((s) => s.queues.get(sessionId) ?? EMPTY_QUEUE);
  const working = isWorking(session.status);
  const awaiting = isAwaiting(session.status);
  // A compaction shows the strip too, idle or not (the phone's "Compacting" hint).
  const busy = working || isCompacting(session);

  const items = useMemo(
    () => (data ? buildChatItems(data.entries, { live: working || awaiting, awaiting, queue }) : []),
    [data, working, awaiting, queue],
  );

  if (!data || data.status === 'loading') {
    return (
      <div className={styles.loading}>
        <EmptyState live title="Loading the conversation…" />
      </div>
    );
  }

  if (data.status === 'error') {
    return (
      <div className={styles.loading}>
        <EmptyState
          title="Couldn’t load the conversation"
          message={data.error ?? undefined}
          action={(
            <>
              <Button variant="primary" onClick={() => void useChatStore.getState().open(sessionId)}>Try again</Button>
              <Button onClick={onTerminal}>Open Terminal</Button>
            </>
          )}
        />
      </div>
    );
  }

  if (data.entries.length === 0 && (data.cli === null || data.after === null)) {
    const fresh = data.cli !== null && (session.promptHistory?.length ?? 0) === 0;
    return (
      <div className={styles.loading} data-testid="chat-no-transcript">
        <EmptyState
          live={!!popup && fresh}
          title={popup ? 'Writing the answer…' : fresh ? 'No messages yet' : 'This session has no transcript'}
          message={popup
            ? 'It shows up here as the agent writes it. The terminal shows it already.'
            : fresh
              ? 'Send a prompt and the conversation shows up here.'
              : 'It’s a shell or another tool. Use Terminal.'}
          action={<Button variant="primary" onClick={onTerminal}>Open Terminal</Button>}
        />
      </div>
    );
  }

  return (
    <ChatBody
      session={session}
      items={items}
      hasOlder={data.hasOlder}
      loadingOlder={data.loadingOlder}
      olderError={data.olderError}
      refreshError={data.refreshError}
      version={data.version}
      initialView={data.view}
      loadOlder={loadOlderAction}
      rememberView={rememberView}
      working={busy}
      onPullBack={onPullBack}
      onTerminal={onTerminal}
      popup={popup}
    />
  );
}

interface ChatBodyProps {
  session: Session;
  items: ChatItem[];
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError: string | null;
  refreshError: string | null;
  version: number;
  initialView?: ChatViewMemory;
  loadOlder: (sessionId: string) => Promise<void>;
  rememberView: (sessionId: string, view: ChatViewMemory) => void;
  /** Working or compacting: shows the status strip and keeps the terminal peek live. */
  working: boolean;
  onPullBack?: (item: QueuedItem) => void;
  onTerminal: () => void;
  popup?: { rootSessionId: string; terminalId: string };
}

function ChatBody({
  session,
  items,
  hasOlder,
  loadingOlder,
  olderError,
  refreshError,
  version,
  initialView,
  loadOlder,
  rememberView,
  working,
  onPullBack,
  onTerminal,
  popup,
}: ChatBodyProps) {
  const { sessionId } = session;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [focusToken, setFocusToken] = useState(0);
  const [searchDismissed, setSearchDismissed] = useState(false);
  // Subscribed for as long as this chat is the screen on show, whatever the session's
  // status: the strip comes and goes every turn, and each new subscription would make
  // the server resend its whole scrollback. Only the strip's display follows `working`.
  const { isTop } = useScreenSlot();
  const peek = useTerminalPeek(session.terminalId, isTop, working);

  const loadOlderHere = useCallback(() => loadOlder(sessionId), [loadOlder, sessionId]);
  const remember = useCallback((view: ChatViewMemory) => rememberView(sessionId, view), [rememberView, sessionId]);
  const scroll = useChatScroll({
    items,
    scrollerRef,
    listRef,
    hasOlder,
    loadingOlder,
    olderError,
    loadOlder: loadOlderHere,
    version,
    initial: initialView,
    onRemember: remember,
  });

  // Stable (rows are memoised): each row says what it wants to become.
  const toggle = useCallback((key: string, open: boolean) => setOpened((s) => ({ ...s, [key]: open })), []);

  const pullBack = useCallback(
    (item: QueuedItem) => (onPullBack ? onPullBack(item) : defaultPullBack(sessionId, item)),
    [onPullBack, sessionId],
  );

  // ── Search: one predicate counts, orders and lights the matches ──
  const matches = useMemo(() => findMatches(items, query), [items, query]);
  const currentKey = matchIndex >= 0 && matchIndex < matches.length ? matches[matchIndex] : null;
  const step = useCallback((direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = matchIndex < 0
      ? (direction === 1 ? 0 : matches.length - 1)
      : (matchIndex + direction + matches.length) % matches.length;
    const key = matches[next];
    setMatchIndex(next);
    // Open the row, and in a folded group the calls that hold the match.
    const item = items.find((i) => i.key === key);
    const q = normalizeQuery(query);
    const members = item?.kind === 'tool-group' ? item.members.filter((m) => matchesQuery(m.searchText, q)).map((m) => m.key) : [];
    setOpened((s) => ({ ...s, [key]: true, ...Object.fromEntries(members.map((k) => [k, true])) }));
    scroll.reveal(key);
  }, [matches, matchIndex, scroll, items, query]);
  const onQuery = useCallback((q: string) => {
    setQuery(q);
    setMatchIndex(-1);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchDismissed(true);
    setQuery('');
    setMatchIndex(-1);
  }, []);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setFocusToken((t) => t + 1);
  }, []);

  const shown = items.slice(scroll.start);
  const rendered = useMemo(() => ({ start: scroll.start, items, opened }), [scroll.start, items, opened]);
  useSearchHighlight(listRef, query, currentKey, rendered);

  // Pulled down while you read back; closing it keeps it away until you are at the newest again.
  const [wasFollowing, setWasFollowing] = useState(scroll.following);
  if (wasFollowing !== scroll.following) {
    setWasFollowing(scroll.following);
    if (scroll.following) setSearchDismissed(false);
  }
  const searchShown = searchOpen || !!query || (!scroll.following && !searchDismissed);
  const atStart = scroll.start === 0 && !hasOlder;

  return (
    <div className={styles.chat} {...{ [SELECTABLE_ATTR]: sessionId }} data-testid="phone-chat">
      <div className={styles.scrollArea}>
        <button type="button" className={styles.srOnlyFocusable} onClick={openSearch}>Search this chat</button>
        <ChatSearchBar
          shown={searchShown}
          query={query}
          onQuery={onQuery}
          count={matches.length}
          index={matchIndex}
          onStep={step}
          onClose={closeSearch}
          partial={scroll.start > 0 || hasOlder}
          focusToken={focusToken}
        />
        <div ref={scrollerRef} className={styles.scroller} onScroll={scroll.onScroll} data-phone-scroll="">
          <div className={styles.top}>
            {atStart ? (
              <span>Start of the conversation</span>
            ) : (
              <Button small variant="plain" onClick={() => scroll.showEarlier()} loading={loadingOlder} loadingLabel="Loading earlier messages">
                Load earlier
              </Button>
            )}
            {olderError && <span role="alert">{olderError}</span>}
          </div>
          <div ref={listRef} className={styles.list} aria-label="Conversation">
            {shown.map((item) => (
              <ChatItemView
                key={item.key}
                item={item}
                sessionId={sessionId}
                expanded={opened[item.key] ?? openByDefault(item)}
                openMembers={openMembersOf(item, opened)}
                current={item.key === currentKey}
                onToggle={toggle}
                onPullBack={pullBack}
              />
            ))}
          </div>
          {refreshError && (
            <div className={styles.stale} role="status">
              <span>Not up to date: {refreshError}</span>
              <Button small variant="plain" onClick={() => void useChatStore.getState().refresh(sessionId)}>Retry</Button>
            </div>
          )}
        </div>
        {scroll.unseen ? (
          <button type="button" className={styles.newActivity} onClick={scroll.jumpToLatest} data-testid="chat-new-activity">
            New activity
            <ArrowDownIcon size={16} />
          </button>
        ) : !scroll.following && (
          <button type="button" className={styles.toLatest} onClick={scroll.jumpToLatest} aria-label="Jump to the latest message">
            <ArrowDownIcon size={20} />
          </button>
        )}
      </div>
      {working && <StatusStrip session={session} peek={peek} onOpenTerminal={onTerminal} />}
      <SelectionReadAloud sessionId={sessionId} overSheet={!!popup} />
      <Suspense fallback={null}>
        <PhoneConversationAi sessionId={sessionId} popup={popup} />
      </Suspense>
    </div>
  );
}
