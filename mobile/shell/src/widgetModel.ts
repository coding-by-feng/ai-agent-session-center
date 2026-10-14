// widgetModel.ts — the home-screen widget's data (AASC-21 M6).
//
// "N sessions need you": approval and input counts, the most urgent session and
// when this was worked out. Two sources feed it:
//   - the session list, whenever the app is open: authoritative, replaces the model
//   - a notification as it arrives: approval/input add the session, finished and
//     interrupted remove it (the session moved on). While the app is closed this
//     needs a native notification extension to run it (README "Decisions").
// The native widget does no logic: it reads WIDGET_STORAGE_KEY from shared
// app-group storage and shows `headline`, `top.title`, `top.label` and `updatedAt`.
// Muted sessions don't count: mute means "don't nag me about this one", as for push.
import type { PushArrival } from './pushPayload.js';
import { SESSION_REF, type SessionLite } from './sessions.js';
import { cleanLabel } from './text.js';

/** The key the widget reads. iOS: UserDefaults(suiteName: WIDGET_IOS_APP_GROUP); Android: SharedPreferences WIDGET_ANDROID_PREFS. */
export const WIDGET_STORAGE_KEY = 'aasc.widget.v1';
export const WIDGET_IOS_APP_GROUP = 'group.work.aasc.mobile';
export const WIDGET_ANDROID_PREFS = 'aasc_widget';
/** A small widget fits about this many characters on one line. */
export const WIDGET_TITLE_MAX = 32;
/** = the Mac's MAX_SESSIONS: every session that needs you fits. */
const MAX_ENTRIES = 50;
export const WIDGET_MAX_BYTES = 16 * 1024;

export type NeedStatus = 'approval' | 'input';

export interface WidgetEntry {
  ref: string;
  status: NeedStatus;
  /** Null when titles are off (generic mode) or unknown. */
  title: string | null;
  /** Since when it needs you (epoch ms): the oldest is the most urgent. */
  since: number;
}

export interface WidgetTop {
  ref: string;
  title: string;
  label: string;
}

export interface WidgetModel {
  v: 1;
  needYou: number;
  approval: number;
  input: number;
  headline: string;
  top: WidgetTop | null;
  updatedAt: number;
  source: 'sessions' | 'push';
  entries: WidgetEntry[];
}

export interface WidgetOptions {
  /** False in generic mode: no session title on the home or lock screen. */
  showTitles: boolean;
}

const LABEL: Readonly<Record<NeedStatus, string>> = { approval: 'Needs approval', input: 'Waiting for input' };

export function widgetHeadline(needYou: number): string {
  if (needYou === 0) return 'Nothing needs you';
  return needYou === 1 ? '1 session needs you' : `${needYou} sessions need you`;
}

/** Approval before input, then the one waiting longest. */
function byUrgency(a: WidgetEntry, b: WidgetEntry): number {
  if (a.status !== b.status) return a.status === 'approval' ? -1 : 1;
  return a.since - b.since || a.ref.localeCompare(b.ref);
}

function fromEntries(entries: readonly WidgetEntry[], now: number, source: WidgetModel['source']): WidgetModel {
  const seen = new Set<string>();
  const sorted = [...entries]
    .sort(byUrgency)
    .filter((e) => !seen.has(e.ref) && Boolean(seen.add(e.ref)))
    .slice(0, MAX_ENTRIES);
  const approval = sorted.filter((e) => e.status === 'approval').length;
  const first = sorted[0];
  return {
    v: 1,
    needYou: sorted.length,
    approval,
    input: sorted.length - approval,
    headline: widgetHeadline(sorted.length),
    top: first ? { ref: first.ref, title: first.title ?? 'A session', label: LABEL[first.status] } : null,
    updatedAt: now,
    source,
    entries: sorted,
  };
}

function widgetTitle(title: string | null | undefined, opts: WidgetOptions): string | null {
  if (!opts.showTitles || !title) return null;
  return cleanLabel(title, WIDGET_TITLE_MAX) || null;
}

/** From the Mac's session list (the app is open). */
export function buildWidgetModel(sessions: readonly SessionLite[], now: number, opts: WidgetOptions): WidgetModel {
  const entries = sessions
    .filter((s): s is SessionLite & { status: NeedStatus } => (s.status === 'approval' || s.status === 'input') && !s.muted)
    .map((s) => ({ ref: s.sessionId, status: s.status, title: widgetTitle(s.title, opts), since: s.lastActivityAt || now }));
  return fromEntries(entries, now, 'sessions');
}

/** One notification applied to the last model (null: nothing stored yet). A test notification changes nothing. */
export function applyPushToWidget(model: WidgetModel | null, arrival: PushArrival, now: number, opts: WidgetOptions): WidgetModel {
  if (arrival.kind === 'test') return model ?? fromEntries([], now, 'push');
  const others = (model?.entries ?? []).filter((e) => e.ref !== arrival.sessionRef);
  const kind = arrival.kind;
  const entries = kind === 'approval' || kind === 'input'
    ? [...others, { ref: arrival.sessionRef, status: kind, title: widgetTitle(arrival.title, opts), since: now }]
    : others;
  return fromEntries(entries, now, 'push');
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The JSON the widget reads, within WIDGET_MAX_BYTES (titles go first, then the least urgent entries). */
export function serializeWidgetModel(model: WidgetModel): string {
  let json = JSON.stringify(model);
  if (bytes(json) <= WIDGET_MAX_BYTES) return json;
  const untitled = { ...model, entries: model.entries.map((e, i) => (i === 0 ? e : { ...e, title: null })) };
  json = JSON.stringify(untitled);
  for (let keep = untitled.entries.length; bytes(json) > WIDGET_MAX_BYTES && keep > 0; keep--) {
    json = JSON.stringify({ ...untitled, entries: untitled.entries.slice(0, keep - 1) });
  }
  return json;
}

function entryOf(raw: unknown): WidgetEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.ref !== 'string' || !SESSION_REF.test(e.ref)) return null;
  if (e.status !== 'approval' && e.status !== 'input') return null;
  if (typeof e.since !== 'number' || !Number.isFinite(e.since)) return null;
  const title = typeof e.title === 'string' ? cleanLabel(e.title, WIDGET_TITLE_MAX) || null : null;
  return { ref: e.ref, status: e.status, title, since: e.since };
}

/** Read a stored model back. Everything shown is recomputed from the entries, so a damaged value can't show stale text. */
export function parseWidgetModel(json: string | null): WidgetModel | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== 1 || !Array.isArray(m.entries) || typeof m.updatedAt !== 'number') return null;
  const entries = m.entries.map(entryOf).filter((e): e is WidgetEntry => e !== null);
  return fromEntries(entries, m.updatedAt, m.source === 'push' ? 'push' : 'sessions');
}
