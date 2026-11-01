/**
 * The iOS Live Activity card the phone app shows on the lock screen and in the Dynamic Island
 * (mobile/ios/AascLiveActivity): the Mac's overall state and its latest sessions, led by the one that
 * matters most now (waiting on you, else working, else the last to finish). Rows that are working or
 * waiting carry the time their turn or request began, which the widget draws as a ticking timer: iOS
 * counts it on its own, so it stays right while the app is suspended and nothing else updates.
 * The lead row also carries a one-line preview of what it is doing. An idle session is a done row
 * flagged `idle` (Nov 2 2026), not a mark of its own: the app already on a phone drops rows with an
 * unknown mark and cards with an unknown headline, so it keeps drawing these as ✓ while a newer app
 * draws them as idle and says "Idle" when every live session is (`idle` against rows + more).
 *
 * The Mac page builds it and hands it to the native app (`useLiveActivityFeed`), which adds the
 * Mac's name from its own saved pairing and draws it. Import-free apart from the title rule, so it
 * is testable without rendering anything.
 */
import { sessionDisplayTitle } from './sessionDisplayTitle';

/** ActivityKit caps the whole state at 4 KB: four rows of short titles stay far below it. */
export const LIVE_ACTIVITY_ROWS = 4;
export const LIVE_ACTIVITY_TITLE_MAX = 60;
export const LIVE_ACTIVITY_DETAIL_MAX = 80;

export type LiveActivityMark = 'needs' | 'working' | 'done';
export type LiveActivityHeadline = 'needs' | 'working' | 'finished';

export interface LiveActivityRow {
  title: string;
  mark: LiveActivityMark;
  /** Epoch ms the turn (working) or request (needs) began; absent on done rows. */
  startedAt?: number;
  /** The lead row only: its latest response, tool call or question, one line. */
  detail?: string;
  /** A done row whose session is idle rather than freshly finished. */
  idle?: true;
}

export interface LiveActivityCard {
  v: 1;
  headline: LiveActivityHeadline;
  rows: LiveActivityRow[];
  /** Live sessions beyond the rows shown. */
  more: number;
  needs: number;
  working: number;
  /** Idle live sessions, shown or not. */
  idle: number;
}

export interface LiveActivitySession {
  status: string;
  lastActivityAt: number;
  title?: string | null;
  projectName?: string | null;
  muted?: boolean;
  promptHistory?: ReadonlyArray<{ timestamp: number }>;
  responseLog?: ReadonlyArray<{ text: string; timestamp: number }>;
  toolLog?: ReadonlyArray<{ tool: string; input: string; timestamp: number }>;
  pendingRequest?: { raisedAt: number } | null;
  pendingTool?: string | null;
  pendingToolDetail?: string | null;
  waitingDetail?: string | null;
}

interface LiveEntry {
  s: LiveActivitySession;
  mark: LiveActivityMark;
}

function markOf(status: string): LiveActivityMark | null {
  if (status === 'approval' || status === 'input') return 'needs';
  if (status === 'prompting' || status === 'working') return 'working';
  if (status === 'waiting' || status === 'idle') return 'done';
  return null; // ended, connecting, restarting…: not on the card
}

function clip(text: string, max = LIVE_ACTIVITY_TITLE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function validTime(t: number | undefined): number | undefined {
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined;
}

function turnStart(s: LiveActivitySession): number | undefined {
  return validTime(s.promptHistory?.at(-1)?.timestamp) ?? validTime(s.lastActivityAt);
}

function startedAt({ s, mark }: LiveEntry): number | undefined {
  if (mark === 'needs') return validTime(s.pendingRequest?.raisedAt) ?? turnStart(s);
  return mark === 'working' ? turnStart(s) : undefined;
}

/** Markdown marks read as noise in a one-line preview. */
function plain(text: string): string {
  return text.replace(/[`*#>]+/g, ' ');
}

function detailOf({ s, mark }: LiveEntry): string | undefined {
  let text: string | null | undefined;
  if (mark === 'needs') {
    text = s.pendingTool && s.pendingToolDetail ? `${s.pendingTool} · ${s.pendingToolDetail}` : s.waitingDetail;
  } else if (mark === 'working') {
    const since = turnStart(s) ?? 0;
    const said = s.responseLog?.at(-1);
    const tool = s.toolLog?.at(-1);
    if (said && said.timestamp >= since) text = plain(said.text);
    else if (tool && tool.timestamp >= since) text = `${tool.tool} · ${tool.input}`;
  } else {
    text = s.responseLog?.at(-1) ? plain(s.responseLog.at(-1)!.text) : null;
  }
  const line = text ? clip(text, LIVE_ACTIVITY_DETAIL_MAX) : '';
  return line || undefined;
}

/** Waiting on you first, then working, then done; the newest of each. */
function leadOf(live: LiveEntry[]): LiveEntry | undefined {
  return live.find((x) => x.mark === 'needs') ?? live.find((x) => x.mark === 'working') ?? live[0];
}

function rowOf(entry: LiveEntry, lead: boolean): LiveActivityRow {
  const row: LiveActivityRow = { title: clip(sessionDisplayTitle(entry.s)), mark: entry.mark };
  const start = startedAt(entry);
  const detail = lead ? detailOf(entry) : undefined;
  return {
    ...row,
    ...(start !== undefined && { startedAt: start }),
    ...(detail !== undefined && { detail }),
    ...(entry.s.status === 'idle' && { idle: true as const }),
  };
}

/** The card for these sessions: the lead, then the rest most recently active first; no rows means "end the activity". */
export function buildLiveActivityCard(sessions: Iterable<LiveActivitySession>): LiveActivityCard {
  const live = [...sessions]
    .filter((s) => !s.muted)
    .map((s) => ({ s, mark: markOf(s.status) }))
    .filter((x): x is LiveEntry => x.mark !== null)
    .sort((a, b) => b.s.lastActivityAt - a.s.lastActivityAt);
  const needs = live.filter((x) => x.mark === 'needs').length;
  const working = live.filter((x) => x.mark === 'working').length;
  const lead = leadOf(live);
  const ordered = lead ? [lead, ...live.filter((x) => x !== lead)] : [];
  return {
    v: 1,
    headline: needs > 0 ? 'needs' : working > 0 ? 'working' : 'finished',
    rows: ordered.slice(0, LIVE_ACTIVITY_ROWS).map((x) => rowOf(x, x === lead)),
    more: Math.max(0, live.length - LIVE_ACTIVITY_ROWS),
    needs,
    working,
    idle: live.filter((x) => x.s.status === 'idle').length,
  };
}

export function sameLiveActivityCard(a: LiveActivityCard | null, b: LiveActivityCard): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}
