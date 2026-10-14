// pushPayload.ts — read a notification the AASC backend sent (AASC-19).
//
// What the backend sends (aasc-backend src/services/push/payload.ts):
//   APNs  aps.alert {title, body}, aps.thread-id = sessionRef, aasc {v: 1, kind, sessionRef}
//   FCM   notification {title, body}, data {v: "1", kind, sessionRef}, android channel_id = kind
// Capacitor hands both over as a PushNotificationSchema: `title`/`body` (absent on
// an Android tap from the tray) and `data`, which is the whole APNs userInfo on
// iOS and the FCM data map on Android. A malformed payload is null: it opens
// nothing and shows nothing.
//
// Generic mode (backend AASC_BE_PUSH_GENERIC=true) replaces the session title with
// GENERIC_PUSH_TITLE and drops the tool name. A missing title counts as generic.
import { SESSION_REF } from './sessions.js';
import { cleanLabel } from './text.js';

export type PushKind = 'approval' | 'input' | 'finished' | 'interrupted' | 'test';
const KINDS: ReadonlySet<string> = new Set<PushKind>(['approval', 'input', 'finished', 'interrupted', 'test']);

/** = the backend's GENERIC_PUSH_TITLE. */
export const GENERIC_PUSH_TITLE = 'A session needs you';

/** = the backend's PUSH_KIND_TEXT: the body line when the payload carried none. */
export const PUSH_KIND_TEXT: Readonly<Record<PushKind, string>> = {
  approval: 'Approval needed',
  input: 'Waiting for your input',
  finished: 'Finished',
  interrupted: 'Interrupted',
  test: 'Test notification',
};

/** What the user reads when there is no session title to show. */
export const GENERIC_TEXT: Readonly<Record<PushKind, string>> = {
  approval: 'A session needs your approval',
  input: 'A session is waiting for your input',
  finished: 'A session finished',
  interrupted: 'A session was interrupted',
  test: 'Test notification from AASC',
};

const TITLE_MAX = 80;
const BODY_MAX = 120;
const MAC_REF = /^[A-Za-z0-9_-]{1,64}$/;

/** Capacitor's PushNotificationSchema, reduced to what is read. */
export interface NotificationLike {
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

export interface PushArrival {
  kind: PushKind;
  sessionRef: string;
  /** The cleaned session title; null in generic mode. */
  title: string | null;
  /** The cleaned body ("Approval needed: Bash"); null when absent or in generic mode. */
  body: string | null;
  generic: boolean;
  /** Grouping key: aps.thread-id, else the session ref (the Mac's collapseKey is the session id too). */
  threadId: string;
  /** The Mac that sent it. The backend doesn't send one yet (README "Decisions"); null until it does. */
  macRef: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The `aasc` dictionary on iOS, the flat data map on Android. */
function aascFields(data: Record<string, unknown>): Record<string, unknown> {
  return record(data.aasc) ?? data;
}

function alertOf(data: Record<string, unknown>): Record<string, unknown> | null {
  return record(record(data.aps)?.alert);
}

export function parsePush(notification: NotificationLike | null | undefined): PushArrival | null {
  const data = record(notification?.data);
  if (!data) return null;
  const fields = aascFields(data);
  if (fields.v !== 1 && fields.v !== '1') return null;
  const { kind, sessionRef } = fields;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (typeof sessionRef !== 'string' || !SESSION_REF.test(sessionRef)) return null;

  const alert = alertOf(data);
  const rawTitle = cleanLabel(notification?.title, TITLE_MAX) || cleanLabel(alert?.title, TITLE_MAX);
  const generic = rawTitle === '' || rawTitle === GENERIC_PUSH_TITLE;
  const rawBody = cleanLabel(notification?.body, BODY_MAX) || cleanLabel(alert?.body, BODY_MAX);
  const thread = record(data.aps)?.['thread-id'];
  const mac = fields.mac;

  return {
    kind: kind as PushKind,
    sessionRef,
    title: generic ? null : rawTitle,
    body: generic || rawBody === '' ? null : rawBody,
    generic,
    threadId: typeof thread === 'string' && SESSION_REF.test(thread) ? thread : sessionRef,
    macRef: typeof mac === 'string' && MAC_REF.test(mac) ? mac : null,
  };
}

/** The text a toast (or a locally presented notification) shows. Generic mode shows no session content. */
export function visibleText(arrival: PushArrival): { title: string; body: string } {
  if (arrival.generic || !arrival.title) return { title: GENERIC_TEXT[arrival.kind], body: '' };
  return { title: arrival.title, body: arrival.body ?? PUSH_KIND_TEXT[arrival.kind] };
}
