/**
 * @module raisedAlerts
 * The rules of an alert a central raises (MCP `alert_raise`, Nov 26 2026), shared by the server (the store, the
 * routes, the phone push) and the browser (the bell, the hint, the sound): how its text is cleaned, and how loud it may
 * be. The person stays in charge of loudness: a central asks for a level, and the session's own level (src/lib/attention.ts)
 * is the ceiling. Set a central's card to Loud and its alerts may be loud; a Silent card's alerts are never shown.
 */
import { ALERT_LEVELS, type AlertLevel } from './attention.js';

/** The longest message kept, after cleaning (a longer one ends in …). */
export const RAISED_ALERT_MESSAGE_MAX = 200;
/** A key is the central's own short name for a problem: `stuck:package`, `queue.empty`. */
export const RAISED_ALERT_KEY_RE = /^[A-Za-z0-9._:-]{1,80}$/;
/** Open alerts one central may hold at once; a new key past it is refused. */
export const RAISED_ALERTS_PER_CENTRAL = 10;
/** Open alerts in all; a new key past it is refused. */
export const RAISED_ALERTS_TOTAL = 100;
/** Raises (new or again) one central may make in a minute. */
export const RAISES_PER_MINUTE = 30;
/** An alert nobody raised again or dismissed for this long goes away. */
export const RAISED_ALERT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One line of plain text: control and format characters become spaces, runs of space one space, and a message past
 * the cap ends in "…". '' when nothing is left.
 */
export function cleanAlertMessage(raw: string): string {
  const flat = raw
    // eslint-disable-next-line no-control-regex -- flattening control characters is the point
    .replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= RAISED_ALERT_MESSAGE_MAX) return flat;
  return `${flat.slice(0, RAISED_ALERT_MESSAGE_MAX - 1).trimEnd()}…`;
}

/** The level an alert sounds at: what the central asked for, never louder than its session's own level. */
export function raisedAlertLevel(asked: AlertLevel | undefined, sessionLevel: AlertLevel): AlertLevel {
  if (asked === undefined) return sessionLevel;
  return ALERT_LEVELS.indexOf(asked) < ALERT_LEVELS.indexOf(sessionLevel) ? asked : sessionLevel;
}
