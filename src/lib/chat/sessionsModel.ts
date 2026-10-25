/**
 * sessionsModel.ts — what the phone's Sessions tab lists, and how (AASC-40).
 *
 *   Needs you   an approval, a question, a turn an interruption stopped
 *   Working     working or starting a turn
 *   Finished    finished a turn you haven't read yet (read = opened or marked read here)
 *   Idle        everything else that is live; folds when long
 *
 * Ended sessions are not listed: they live in History. Group by Room and Project
 * use the desktop strip's own grouping (lib/sessionStrip.ts) on the desktop's
 * status order (numberedSessions), so a session sits in the same frame, in the
 * same place, on both. Pure: no store, no DOM.
 */
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import { needsYou, waitingLine } from './inboxModel';
import { buildStripItems } from '@/lib/sessionStrip';
import { pickRecentSessions } from '@/lib/recentSessions';
import { roomsInListOrder } from '@/lib/roomOrder';
import { roomColor } from '@/lib/roomColor';
import { numberedSessions, sortSessionsByActivity } from '@/lib/sessionSort';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { owesProceed } from '@/lib/sessionStatusStyle';

export type SessionsFilter = 'all' | 'needs-you' | 'working';
/** `activity`: one list, most recently active first: the desktop strip's Recent activity view (Oct 20 2026). */
export type SessionsGroupBy = 'status' | 'room' | 'project' | 'activity';
export type StatusSection = 'needs-you' | 'working' | 'finished' | 'idle';

export const SESSIONS_FILTERS: ReadonlyArray<{ value: SessionsFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'working', label: 'Working' },
];

/** `chip`: what the Sessions tab's grouping chip says (short: it shares a row with the filters). */
export const GROUP_BY_OPTIONS: ReadonlyArray<{ value: SessionsGroupBy; label: string; chip: string }> = [
  { value: 'status', label: 'Status', chip: 'By status' },
  { value: 'room', label: 'Room', chip: 'By room' },
  { value: 'project', label: 'Project', chip: 'By project' },
  { value: 'activity', label: 'Recent activity', chip: 'By recent' },
];

const SECTION_TITLES: Record<StatusSection, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  finished: 'Finished',
  idle: 'Idle',
};

/** More idle sessions than this and the Idle section starts folded. */
export const IDLE_FOLD_AT = 4;

/** When this device last read each session (opened it, or marked it read), by id. */
export type ReadMap = Readonly<Record<string, number>>;

type SectionFields = Pick<Session, 'sessionId' | 'status' | 'interruption' | 'lastActivityAt' | 'pendingProceedAt'>;

/** A finished turn you haven't seen: it finished after you last read the session. */
export function isUnreadFinish(session: SectionFields, reads: ReadMap): boolean {
  return session.status === 'waiting' && (reads[session.sessionId] ?? 0) < (session.lastActivityAt ?? 0);
}

export function statusSection(session: SectionFields, reads: ReadMap = {}): StatusSection {
  // Its last answer asks you to reply "proceed" (Oct 23 2026): under Idle it would fold away.
  if (needsYou(session) || owesProceed(session)) return 'needs-you';
  if (session.status === 'working' || session.status === 'prompting') return 'working';
  if (isUnreadFinish(session, reads)) return 'finished';
  return 'idle';
}

export function matchesFilter(session: SectionFields, filter: SessionsFilter): boolean {
  if (filter === 'needs-you') return needsYou(session) || owesProceed(session);
  if (filter === 'working') return !needsYou(session) && (session.status === 'working' || session.status === 'prompting');
  return true;
}

/** Search by name, project and remark; every word must match somewhere. */
export function matchesSearch(session: Session, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [sessionDisplayTitle(session), session.projectName, session.projectPath, session.remark]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const firstLine = (text: string | undefined | null): string =>
  (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/**
 * The one line that matters now: the pending ask, the tool running, or the start
 * of the last answer (the last prompt when there is no answer yet).
 */
export function nowLine(session: Session): string {
  if (needsYou(session)) return waitingLine(session);
  const working = session.status === 'working' || session.status === 'prompting';
  if (working) {
    const tool = session.toolLog?.[session.toolLog.length - 1];
    if (tool && tool.timestamp >= (session.promptHistory?.[session.promptHistory.length - 1]?.timestamp ?? 0)) {
      return `${tool.tool}: ${firstLine(tool.input)}`.replace(/:\s*$/, '');
    }
    return session.currentPrompt ? `Working on: ${firstLine(session.currentPrompt)}` : 'Working';
  }
  const answer = session.responseLog?.[session.responseLog.length - 1];
  if (answer && firstLine(answer.text)) return firstLine(answer.text);
  const prompt = session.promptHistory?.[session.promptHistory.length - 1];
  if (prompt && firstLine(prompt.text)) return `You: ${firstLine(prompt.text)}`;
  return session.status === 'idle' ? 'Ready for a prompt' : '';
}

/** "now", "4m", "2h", "3d": how long since the session last did something. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type ConnectionPath = 'this-mac' | 'tailscale' | 'home' | 'internet';

export const CONNECTION_WORDS: Record<ConnectionPath, string> = {
  'this-mac': 'On this Mac',
  tailscale: 'Tailscale · encrypted',
  home: 'Home network',
  internet: 'Over the internet',
};

/** How this page reaches the Mac, from the address it was loaded from. */
export function connectionPath(hostname: string): ConnectionPath {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'this-mac';
  if (host.endsWith('.ts.net')) return 'tailscale';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'home';
    return 'internet';
  }
  if (host.endsWith('.local') || !host.includes('.')) return 'home';
  return 'internet';
}

export interface SessionGroup {
  /** Stable: React key and fold state. */
  key: string;
  /** recent / pinned: the desktop rail's built-in RECENT and PINNED frames (By room only); not rooms. */
  kind: 'status' | 'room' | 'project' | 'none' | 'recent' | 'pinned';
  title: string;
  sessions: Session[];
  /** Status groups: which section. */
  section?: StatusSection;
  /** Room groups: the room (its menu kills its live sessions). */
  room?: Room;
  /** Room and project groups: the frame colour. */
  color?: string;
  /** Project groups: where a new session starts, and whether it can start here. */
  launchPath?: string;
  local?: boolean;
}

export interface GroupInput {
  sessions: Iterable<Session>;
  groupBy: SessionsGroupBy;
  filter: SessionsFilter;
  query: string;
  rooms: readonly Room[];
  reads: ReadMap;
  /** The clock Recent is measured against (a session leaves it after 30 quiet minutes). */
  now: number;
}

const byRecent = (a: Session, b: Session) =>
  (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.sessionId.localeCompare(b.sessionId);
const byLongestWaiting = (a: Session, b: Session) =>
  (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0) || a.sessionId.localeCompare(b.sessionId);

const SECTION_ORDER: readonly StatusSection[] = ['needs-you', 'working', 'finished', 'idle'];

/** The listed groups, in the order they are drawn; empty groups are left out. */
export function groupSessions({ sessions, groupBy, filter, query, rooms, reads, now }: GroupInput): SessionGroup[] {
  // Live, never a floating AI popup (it shows over its own session), filtered and searched.
  const listed = numberedSessions(sessions).filter(
    (s) => !s.isFloating && matchesFilter(s, filter) && matchesSearch(s, query),
  );

  if (groupBy === 'status') {
    const buckets = new Map<StatusSection, Session[]>(SECTION_ORDER.map((k) => [k, []]));
    for (const s of listed) buckets.get(statusSection(s, reads))?.push(s);
    return SECTION_ORDER.flatMap((section) => {
      const list = buckets.get(section) ?? [];
      if (list.length === 0) return [];
      const sorted = [...list].sort(section === 'needs-you' ? byLongestWaiting : byRecent);
      return [{ key: `status:${section}`, kind: 'status' as const, title: SECTION_TITLES[section], sessions: sorted, section }];
    });
  }

  if (groupBy === 'activity') {
    // The desktop's own ordering for this view (sessionSort), so both list the same order.
    return listed.length > 0 ? [{ key: 'activity', kind: 'none', title: 'Recent activity', sessions: sortSessionsByActivity(listed) }] : [];
  }

  // By room, Pinned then Recent go first, as the desktop rail's PINNED and RECENT frames
  // (Oct 22 2026 for Pinned): their rules and order (sessionStrip.ts, recentSessions.ts),
  // narrowed by the filter and search; each session also stays in its room.
  const byRoom = groupBy === 'room';
  const recentIds = byRoom ? pickRecentSessions(listed, now).map((s) => s.sessionId) : [];
  const items = buildStripItems({ filtered: listed, all: listed, rooms, mode: groupBy, recentIds, showPinned: byRoom });
  const groups: SessionGroup[] = [];
  const loose: Session[] = [];
  const roomGroup = (room: Room, list: Session[], color: string): SessionGroup =>
    ({ key: `room:${room.id}`, kind: 'room', title: room.name, sessions: list, room, color });
  // AASC-55: unfiltered, every room has a group, an empty one too — something
  // to drop a session into, and to reorder, fold or kill like any other. The
  // desktop strip leaves empty rooms out; filtered or searched, so does the phone.
  const showEmptyRooms = groupBy === 'room' && filter === 'all' && !query.trim();
  const framed = new Set(items.flatMap((item) => (item.type === 'room' ? [item.room.id] : [])));
  const ordered = showEmptyRooms ? roomsInListOrder(rooms) : [];
  const emptyRooms = ordered.filter((r) => !framed.has(r.id));
  const rank = (r: Room) => ordered.indexOf(r);
  const placeEmptyBefore = (room: Room | null) => {
    // Empty rooms go where list order puts them: before the first framed room that ranks after them.
    while (emptyRooms.length > 0 && (room === null || rank(emptyRooms[0]) < rank(room))) {
      const empty = emptyRooms.shift()!;
      groups.push(roomGroup(empty, [], roomColor(empty)));
    }
  };
  for (const item of items) {
    if (item.type === 'pinned') {
      groups.push({ key: 'pinned', kind: 'pinned', title: 'Pinned', sessions: item.sessions });
    } else if (item.type === 'recent') {
      groups.push({ key: 'recent', kind: 'recent', title: 'Recent', sessions: item.sessions });
    } else if (item.type === 'room') {
      placeEmptyBefore(item.room);
      groups.push(roomGroup(item.room, item.sessions, item.color));
    } else if (item.type === 'project') {
      const { group } = item;
      groups.push({
        key: `project:${group.key}`,
        kind: 'project',
        title: group.label,
        sessions: group.sessions,
        color: item.color,
        launchPath: group.launchPath,
        local: group.local,
      });
    } else if (item.type === 'session') {
      loose.push(item.session);
    }
  }
  placeEmptyBefore(null);
  if (loose.length > 0) {
    groups.push({ key: `none:${groupBy}`, kind: 'none', title: groupBy === 'room' ? 'No room' : 'No project', sessions: loose });
  }
  return groups;
}

/** How many listed sessions a filter chip would show (its count). */
export function filterCount(sessions: Iterable<SectionFields & { isFloating?: boolean }>, filter: SessionsFilter): number {
  let n = 0;
  for (const s of sessions) if (s.status !== 'ended' && !s.isFloating && matchesFilter(s, filter)) n += 1;
  return n;
}
