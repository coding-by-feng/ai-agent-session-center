/**
 * @module attentionInbox
 * What waits on the person (Nov 26 2026): the header bell's list and its hint. Pure rules, driven by
 * useAttentionInbox:
 *
 *   waitKindOf    the moment a session stands on: a question, an approval, a proceed ask, or none
 *   waitingItems  every session that waits, and every alert a central raised (src/types/alert.ts), as one list,
 *                 newest first. A session's alert level decides whether it is listed at all (its `hint` output:
 *                 Silent never is); a central's alert is listed at the level it asked for under the session's own
 *                 (src/lib/raisedAlerts.ts). A finished turn is not here: review comes with the Flow lanes.
 *   newMoments    the items that were not there at the last look (a first look never counts, so opening AASC
 *                 doesn't bring every standing wait back as a hint)
 *   pruneHidden   the bell's × hides a session's item until that moment is over; then the next one shows
 *   mergeHint     one hint at a time: moments that come while one shows fold into it ("+2 more"), never a stack
 */
import type { AlertLevel, AlertLevelOutputs } from './attention';
import { raisedAlertLevel } from './raisedAlerts';
import { sessionDisplayTitle } from './sessionDisplayTitle';
import type { RaisedAlert } from '@/types/alert';

/** How long a hint shows; a moment that comes meanwhile folds into it and shows it this long again. */
export const HINT_SHOW_MS = 6_000;
/** Moments within this long of the hint on screen join it. The hint's own time on screen. */
export const HINT_MERGE_MS = HINT_SHOW_MS;
/** How long a moment must stand before it hints: a timer-guessed approval can clear within a second. */
export const HINT_SETTLE_MS = 1_500;
/** The longest detail line the list shows; the alert's whole text is its tooltip. */
export const WAIT_DETAIL_MAX = 120;

export type WaitKind = 'question' | 'approval' | 'proceed' | 'alert';

/** What a session must offer the inbox. */
export interface InboxSession {
  sessionId: string;
  status: string;
  title?: string | null;
  projectName?: string | null;
  lastActivityAt?: number;
  pendingProceedAt?: number | null;
  pendingTool?: string | null;
  pendingRequest?: { kind: 'permission' | 'question' | 'plan'; raisedAt: number; tool: string } | null;
  isFloating?: boolean;
}

export interface WaitItem {
  /** `<sessionId>:<kind>` for a session's moment, `alert:<id>` for a central's alert. */
  key: string;
  kind: WaitKind;
  sessionId: string;
  title: string;
  /** What it asks, in a few words; a central's alert is its message. */
  detail: string;
  since: number;
  level: AlertLevel;
  /** A central's alert: its id (× dismisses it for everyone). */
  alertId?: string;
  /** A central's alert about another card: the title of the central's card. */
  from?: string;
}

export interface InboxContext {
  alertOf: (session: InboxSession) => { level: AlertLevel; outputs: AlertLevelOutputs };
  outputsOf: (level: AlertLevel) => AlertLevelOutputs;
  /** When each item was first seen in this window: the age of a wait the session itself does not date. */
  seenAt: ReadonlyMap<string, number>;
}

export function waitKindOf(s: InboxSession): Exclude<WaitKind, 'alert'> | null {
  if (s.status === 'input' || (s.status === 'approval' && s.pendingRequest?.kind === 'question')) return 'question';
  if (s.status === 'approval') return 'approval';
  if (s.pendingProceedAt && (s.status === 'waiting' || s.status === 'idle')) return 'proceed';
  return null;
}

function detailOf(kind: Exclude<WaitKind, 'alert'>, s: InboxSession): string {
  if (kind === 'question') return 'needs your answer';
  if (kind === 'proceed') return 'asks to proceed';
  if (s.pendingRequest?.kind === 'plan') return 'approve plan';
  const tool = (s.pendingRequest?.tool ?? s.pendingTool ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
  return tool ? `approve ${tool}` : 'approval';
}

function sinceOf(kind: Exclude<WaitKind, 'alert'>, s: InboxSession, key: string, seenAt: ReadonlyMap<string, number>): number {
  if (kind === 'proceed' && s.pendingProceedAt) return s.pendingProceedAt;
  if (kind !== 'proceed' && s.pendingRequest?.raisedAt) return s.pendingRequest.raisedAt;
  return seenAt.get(key) ?? s.lastActivityAt ?? 0;
}

const clip = (text: string): string => (text.length > WAIT_DETAIL_MAX ? `${text.slice(0, WAIT_DETAIL_MAX - 1)}…` : text);

export function waitingItems(sessions: Iterable<InboxSession>, alerts: readonly RaisedAlert[], ctx: InboxContext): WaitItem[] {
  const byId = new Map<string, InboxSession>();
  const items: WaitItem[] = [];
  for (const s of sessions) {
    byId.set(s.sessionId, s);
    if (s.isFloating) continue;
    const kind = waitKindOf(s);
    if (!kind) continue;
    const { level, outputs } = ctx.alertOf(s);
    if (!outputs.hint) continue;
    const key = `${s.sessionId}:${kind}`;
    items.push({ key, kind, sessionId: s.sessionId, title: sessionDisplayTitle(s), detail: detailOf(kind, s), since: sinceOf(kind, s, key, ctx.seenAt), level });
  }
  for (const a of alerts) {
    const s = byId.get(a.sessionId);
    if (!s) continue;
    const level = raisedAlertLevel(a.level, ctx.alertOf(s).level);
    if (!ctx.outputsOf(level).hint) continue;
    const central = a.centralSessionId && a.centralSessionId !== a.sessionId ? byId.get(a.centralSessionId) : undefined;
    items.push({
      key: `alert:${a.id}`,
      kind: 'alert',
      sessionId: s.sessionId,
      title: sessionDisplayTitle(s),
      detail: clip(a.message),
      since: a.updatedAt,
      level,
      alertId: a.id,
      ...(central ? { from: sessionDisplayTitle(central) } : {}),
    });
  }
  return items.sort((a, b) => b.since - a.since);
}

/** "now", "4m", "3h", "2d": how long it has waited. */
export function waitAge(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function newMoments(prevKeys: ReadonlySet<string> | null, items: readonly WaitItem[]): WaitItem[] {
  if (prevKeys === null) return [];
  return items.filter((i) => !prevKeys.has(i.key));
}

/** The hidden keys whose items are still listed; the same set when nothing went. */
export function pruneHidden(hidden: ReadonlySet<string>, items: readonly WaitItem[]): ReadonlySet<string> {
  const live = new Set(items.map((i) => i.key));
  const kept = [...hidden].filter((k) => live.has(k));
  return kept.length === hidden.size ? hidden : new Set(kept);
}

export interface Hint {
  item: WaitItem;
  /** Moments folded into this hint besides the one it names. */
  more: number;
  shownAt: number;
}

export function mergeHint(current: Hint | null, fresh: readonly WaitItem[], now: number): Hint | null {
  if (fresh.length === 0) return current;
  const newest = [...fresh].sort((a, b) => b.since - a.since)[0];
  if (current && now - current.shownAt < HINT_MERGE_MS) {
    return { item: newest, more: current.more + fresh.length, shownAt: now };
  }
  return { item: newest, more: fresh.length - 1, shownAt: now };
}
