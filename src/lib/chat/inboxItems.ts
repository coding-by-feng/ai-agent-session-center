/**
 * inboxItems.ts — what the Inbox tab lists (AASC-43). Pure, apart from the
 * read-state storage at the end.
 *
 *   approval / question   a session waiting on you (its request, or its status alone)
 *   interrupted           a turn an API error, a limit or the network stopped (Continue)
 *   continue-all          two or more of those, or the sessions an AASC restart cut
 *                         off (interruptedRestore's offer): one "Continue all"
 *   finished              a turn that ended in the last 12 hours, with the start of its answer
 *
 * What waits comes first, the longest waiting first (the triage order of
 * inboxModel); finished turns follow, newest first. An item's id carries what
 * it is about (the request id, the interruption's time, the answer's time), so
 * a new request on the same session is unread again. "Read" is this phone's own
 * (localStorage), never synced.
 */
import type { Session } from '@/types';
import type { InterruptedOffer } from '@/lib/interruptedRestore';
import { waitingCardModel } from './waitingCardModel';

export type InboxKind = 'approval' | 'question' | 'interrupted' | 'continue-all' | 'finished';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  /** The session it is about; null for continue-all, which names several. */
  sessionId: string | null;
  /** Every session the item acts on (continue-all: all of them). */
  sessionIds: string[];
  title: string;
  line: string;
  at: number;
  /** Counts as waiting for you (not a finished turn). */
  waiting: boolean;
  /** continue-all: why those sessions stopped. */
  reason?: 'restart' | 'interruptions';
}

export type InboxFilter = 'waiting' | 'finished' | 'all';

/** Finished turns older than this leave the Inbox. */
export const FINISHED_WINDOW_MS = 12 * 60 * 60_000;
const LINE_CHARS = 140;

export interface InboxOptions {
  titleOf: (session: Session) => string;
  now: number;
  /** interruptedRestore's offer, when this device holds one. */
  offer?: InterruptedOffer | null;
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 1)}…` : flat;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a waiting session wants, in words ("Wants to run: npm run build"). */
function askLine(session: Session): string {
  const card = waitingCardModel(session);
  if (!card) return 'Waiting for you';
  const { detail } = card;
  if (detail.type === 'question') return oneLine(detail.question);
  if (detail.type === 'command') return oneLine(`Wants to run: ${detail.command}`);
  if (detail.type === 'diff') return oneLine(`Wants to edit: ${detail.file}`);
  if (detail.type === 'url') return oneLine(`Wants to fetch: ${detail.url}`);
  if (detail.type === 'plan') return 'Has a plan for you to approve';
  if (card.kind === 'guess' && detail.type === 'text') return oneLine(`Wants to run: ${detail.text}`);
  if (card.kind === 'guess') return 'Wants your approval';
  return oneLine(card.title.replace(/^\w+ wants/, 'Wants'));
}

function waitingItem(session: Session, titleOf: (s: Session) => string): InboxItem | null {
  const request = session.pendingRequest ?? null;
  const asking = request ? request.kind === 'question' : session.status === 'input';
  const approving = request ? !asking : session.status === 'approval';
  if (!asking && !approving) return null;
  const kind: InboxKind = asking ? 'question' : 'approval';
  const stamp = request?.id ?? `${session.status}:${session.pendingToolDetail ?? session.waitingDetail ?? ''}`;
  return {
    id: `${kind}:${session.sessionId}:${stamp}`,
    kind,
    sessionId: session.sessionId,
    sessionIds: [session.sessionId],
    title: titleOf(session),
    line: askLine(session),
    at: request?.raisedAt ?? session.lastActivityAt ?? 0,
    waiting: true,
  };
}

function lastResponse(session: Session): { text: string; timestamp: number } | null {
  const log = session.responseLog ?? [];
  const last = log[log.length - 1];
  return last && last.text ? last : null;
}

export function inboxItems(sessions: ReadonlyMap<string, Session>, opts: InboxOptions): InboxItem[] {
  const { titleOf, now } = opts;
  const waiting: InboxItem[] = [];
  const finished: InboxItem[] = [];
  const interrupted: Session[] = [];

  for (const session of sessions.values()) {
    if (session.status === 'ended') continue;
    const asking = waitingItem(session, titleOf);
    if (asking) {
      waiting.push(asking);
      continue;
    }
    if (session.interruption) {
      interrupted.push(session);
      waiting.push({
        id: `interrupted:${session.sessionId}:${session.interruption.detectedAt}`,
        kind: 'interrupted',
        sessionId: session.sessionId,
        sessionIds: [session.sessionId],
        title: titleOf(session),
        line: oneLine(`Stopped: ${session.interruption.line}`),
        at: session.interruption.detectedAt,
        waiting: true,
      });
      continue;
    }
    if (session.status !== 'waiting' && session.status !== 'idle') continue;
    const answer = lastResponse(session);
    if (!answer || now - answer.timestamp > FINISHED_WINDOW_MS) continue;
    finished.push({
      id: `finished:${session.sessionId}:${answer.timestamp}`,
      kind: 'finished',
      sessionId: session.sessionId,
      sessionIds: [session.sessionId],
      title: titleOf(session),
      line: oneLine(answer.text),
      at: answer.timestamp,
      waiting: false,
    });
  }

  waiting.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  finished.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const top: InboxItem[] = [];

  const offered = opts.offer
    ? opts.offer.items
      .map((item) => [...sessions.values()].find((s) => s.terminalId === item.terminalId && s.status !== 'ended'))
      .filter((s): s is Session => !!s)
    : [];
  if (opts.offer && offered.length > 0) {
    top.push({
      id: `restart:${opts.offer.restoreStartedAt}`,
      kind: 'continue-all',
      sessionId: null,
      sessionIds: offered.map((s) => s.sessionId),
      title: `${plural(offered.length, 'session')} ${offered.length === 1 ? 'was' : 'were'} interrupted`,
      line: 'AASC restarted while they were working. Continue them from where they stopped.',
      at: opts.offer.restoreStartedAt,
      waiting: true,
      reason: 'restart',
    });
  } else if (interrupted.length >= 2) {
    const ordered = [...interrupted].sort((a, b) => (a.interruption?.detectedAt ?? 0) - (b.interruption?.detectedAt ?? 0));
    top.push({
      id: `continue-all:${ordered.map((s) => `${s.sessionId}@${s.interruption?.detectedAt}`).join(',')}`,
      kind: 'continue-all',
      sessionId: null,
      sessionIds: ordered.map((s) => s.sessionId),
      title: `${plural(ordered.length, 'session')} stopped`,
      line: 'An error, a limit or the network stopped their turns. Continue them all.',
      at: ordered[0].interruption?.detectedAt ?? now,
      waiting: true,
      reason: 'interruptions',
    });
  }
  return [...top, ...waiting, ...finished];
}

/** How long ago, briefly: "now", "2m", "1h", "1d". */
export function inboxAge(at: number, now: number): string {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function filterInbox(items: readonly InboxItem[], filter: InboxFilter): InboxItem[] {
  if (filter === 'all') return [...items];
  return items.filter((item) => (filter === 'waiting' ? item.waiting : !item.waiting));
}

/**
 * How many sessions wait (the Waiting chip): a "continue all" card acts on
 * sessions already counted, or on ones that don't wait, so it adds none. Says
 * the same number as the tab bar's Inbox badge (inboxModel.inboxCount).
 */
export function waitingCount(items: readonly InboxItem[]): number {
  return items.filter((item) => item.waiting && item.kind !== 'continue-all').length;
}

// ---------------------------------------------------------------------------
// Read state: this phone's own
// ---------------------------------------------------------------------------

/** item id → when it was read. */
export type ReadState = Readonly<Record<string, number>>;

const READ_KEY = 'aasc.inboxRead';
const MAX_READ_ENTRIES = 500;

export function unreadCount(items: readonly InboxItem[], read: ReadState): number {
  return items.filter((item) => read[item.id] === undefined).length;
}

/** `read` with `ids` marked at `now`, the oldest entries dropped past the cap. */
export function markRead(read: ReadState, ids: readonly string[], now: number): ReadState {
  const next: Record<string, number> = { ...read };
  for (const id of ids) next[id] = now;
  const entries = Object.entries(next);
  if (entries.length <= MAX_READ_ENTRIES) return next;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_READ_ENTRIES));
}

export function loadReadState(): ReadState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}

export function saveReadState(read: ReadState): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(read));
  } catch {
    /* private mode or full: read marks last until the page reloads */
  }
}
