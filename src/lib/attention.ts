/**
 * @module attention
 * Alert levels (Nov 25 2026): how loudly a session asks for you. Five levels, Silent to Urgent, replace the Mute and
 * Alert switches. Each level's outputs (sound, desktop notification, phone push, glowing card, repeat) come from one
 * table the person can edit in Settings; its defaults do what Mute, nothing and Alert did before.
 *
 * A session's level is its own when it chose one, else its room's (`Room.alertLevel`), else the table's default.
 * The server keeps the older switches as a mirror of the session's own level (Silent is `muted`, Loud and Urgent are
 * `alerted`), so an older client, a Client edition or a phone build keeps working, and a session or snapshot that
 * carries only the switches still resolves (`ownAlertLevel`).
 *
 * Pure and shared: the server decides phone pushes with it, the browser sounds and notifications.
 */
import { z } from 'zod';

export const ALERT_LEVELS = ['silent', 'quiet', 'normal', 'loud', 'urgent'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const ALERT_LEVEL_LABEL: Readonly<Record<AlertLevel, string>> = {
  silent: 'Silent',
  quiet: 'Quiet',
  normal: 'Normal',
  loud: 'Loud',
  urgent: 'Urgent',
};

/** none; the sounds Settings ▸ Sound picks; or the moments that need you loud, over mute and sounds off. */
export type AlertSound = 'none' | 'normal' | 'loud';
/** No desktop notification; only for a "proceed" ask; or for every finish, approval and question. */
export type AlertNotify = 'none' | 'proceed' | 'all';

export interface AlertLevelOutputs {
  sound: AlertSound;
  notify: AlertNotify;
  /** A push to the paired phone (shared sessions only; the server decides it). */
  push: boolean;
  /** The card's glowing ring while it finished unseen or needs you. */
  glow: boolean;
  /** Listed in the header's bell (the bell arrives with the next phase). */
  hint: boolean;
  /** Minutes between reminders of a moment you have not handled; 0 is never. */
  repeatMin: number;
}

export interface AlertConfig {
  /** The level of a session that has none of its own and is in no room with one. */
  defaultLevel: AlertLevel;
  levels: Record<AlertLevel, AlertLevelOutputs>;
}

/** The repeat choices Settings offers, in minutes (0: off). */
export const REPEAT_MINUTES = [0, 1, 2, 5, 10, 15, 30] as const;
export const REPEAT_MAX_MIN = 60;

const SILENT: AlertLevelOutputs = { sound: 'none', notify: 'none', push: false, glow: false, hint: false, repeatMin: 0 };

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  defaultLevel: 'normal',
  levels: {
    silent: SILENT,
    quiet: { sound: 'none', notify: 'none', push: false, glow: false, hint: true, repeatMin: 0 },
    normal: { sound: 'normal', notify: 'proceed', push: true, glow: false, hint: true, repeatMin: 0 },
    loud: { sound: 'loud', notify: 'all', push: true, glow: true, hint: true, repeatMin: 0 },
    urgent: { sound: 'loud', notify: 'all', push: true, glow: true, hint: true, repeatMin: 5 },
  },
};

export function isAlertLevel(value: unknown): value is AlertLevel {
  return typeof value === 'string' && (ALERT_LEVELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// A session's level
// ---------------------------------------------------------------------------

/** What a session carries that says how loud it is. */
export interface AlertLevelCarrier {
  alertLevel?: AlertLevel | null;
  muted?: boolean;
  alerted?: boolean;
}

/**
 * The level a session chose for itself, or undefined when it follows its room and the default. One with only the
 * older switches (an older client, a snapshot saved before levels) reads them: Alert wins over Mute, as it did.
 */
export function ownAlertLevel(session: AlertLevelCarrier): AlertLevel | undefined {
  if (isAlertLevel(session.alertLevel)) return session.alertLevel;
  if (session.alerted === true) return 'loud';
  if (session.muted === true) return 'silent';
  return undefined;
}

export type AlertLevelSource = 'session' | 'room' | 'default';

/** The session's level and where it came from (the picker shows a followed level as such). */
export function describeAlertLevel(
  session: AlertLevelCarrier,
  roomLevel: AlertLevel | null | undefined,
  defaultLevel: AlertLevel,
): { level: AlertLevel; source: AlertLevelSource } {
  const own = ownAlertLevel(session);
  if (own) return { level: own, source: 'session' };
  if (isAlertLevel(roomLevel)) return { level: roomLevel, source: 'room' };
  return { level: isAlertLevel(defaultLevel) ? defaultLevel : 'normal', source: 'default' };
}

export function resolveAlertLevel(
  session: AlertLevelCarrier,
  roomLevel: AlertLevel | null | undefined,
  defaultLevel: AlertLevel,
): AlertLevel {
  return describeAlertLevel(session, roomLevel, defaultLevel).level;
}

/** The level of the room that holds the session, if it has one (a session is in one room at most). */
export function roomAlertLevelOf(
  sessionId: string,
  rooms: readonly { sessionIds: readonly string[]; alertLevel?: AlertLevel }[],
): AlertLevel | undefined {
  const level = rooms.find((r) => r.sessionIds.includes(sessionId))?.alertLevel;
  return isAlertLevel(level) ? level : undefined;
}

// ---------------------------------------------------------------------------
// The older Mute and Alert switches
// ---------------------------------------------------------------------------

/** The switches as a session's own level sets them (null: it has none). */
export function legacyFlags(level: AlertLevel | null): { muted: boolean; alerted: boolean } {
  return { muted: level === 'silent', alerted: level === 'loud' || level === 'urgent' };
}

/**
 * The level a Mute switch asks for: on is Silent; off lets a Silent session follow its room and the default again,
 * or makes it Normal when those are Silent too. A level to set, null to clear it, undefined for no change.
 */
export function levelAfterMute(own: AlertLevel | undefined, followed: AlertLevel, muted: boolean): AlertLevel | null | undefined {
  if (muted) return 'silent';
  if (own !== undefined && own !== 'silent') return undefined;
  return followed === 'silent' ? 'normal' : null;
}

const isLoud = (level: AlertLevel | undefined): boolean => level === 'loud' || level === 'urgent';

/**
 * The level an Alert switch asks for: on is Loud (an Urgent session stays Urgent); off lets the session follow its
 * room and the default again, or makes it Normal when those are loud too. Same answers as `levelAfterMute`.
 */
export function levelAfterAlert(own: AlertLevel | undefined, followed: AlertLevel, alerted: boolean): AlertLevel | null | undefined {
  if (alerted) return isLoud(own) ? undefined : 'loud';
  if (own !== undefined && !isLoud(own)) return undefined;
  return isLoud(followed) ? 'normal' : null;
}

// ---------------------------------------------------------------------------
// The level table
// ---------------------------------------------------------------------------

const levelSchema = z.enum(ALERT_LEVELS);
const outputsSchema = z.object({
  sound: z.enum(['none', 'normal', 'loud']),
  notify: z.enum(['none', 'proceed', 'all']),
  push: z.boolean(),
  glow: z.boolean(),
  hint: z.boolean(),
  repeatMin: z.number().int().min(0).max(REPEAT_MAX_MIN),
});

const strictConfigSchema = z.object({
  defaultLevel: levelSchema,
  levels: z.object({
    silent: outputsSchema,
    quiet: outputsSchema,
    normal: outputsSchema,
    loud: outputsSchema,
    urgent: outputsSchema,
  }),
});

/** Silent is the one fixed row: the name promises nothing is heard, sent or shown. */
function withFixedSilent(config: AlertConfig): AlertConfig {
  return { ...config, levels: { ...config.levels, silent: SILENT } };
}

/** One field of a saved row, or the default's when it is missing or wrong. */
function lenientOutputs(raw: unknown, fallback: AlertLevelOutputs): AlertLevelOutputs {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof AlertLevelOutputs>(key: K): AlertLevelOutputs[K] => {
    const parsed = outputsSchema.shape[key].safeParse(row[key]);
    return (parsed.success ? parsed.data : fallback[key]) as AlertLevelOutputs[K];
  };
  return {
    sound: pick('sound'),
    notify: pick('notify'),
    push: pick('push'),
    glow: pick('glow'),
    hint: pick('hint'),
    repeatMin: pick('repeatMin'),
  };
}

/** A saved table, read leniently: anything missing or wrong is the default's. */
export function parseAlertConfig(raw: unknown): AlertConfig {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const levels = body.levels && typeof body.levels === 'object' ? (body.levels as Record<string, unknown>) : {};
  const next = {} as Record<AlertLevel, AlertLevelOutputs>;
  for (const level of ALERT_LEVELS) next[level] = lenientOutputs(levels[level], DEFAULT_ALERT_CONFIG.levels[level]);
  return withFixedSilent({
    defaultLevel: isAlertLevel(body.defaultLevel) ? body.defaultLevel : DEFAULT_ALERT_CONFIG.defaultLevel,
    levels: next,
  });
}

/** A whole table from a request, or null when any part of it is missing or wrong. Silent is kept silent. */
export function readAlertConfigBody(raw: unknown): AlertConfig | null {
  const parsed = strictConfigSchema.safeParse(raw);
  return parsed.success ? withFixedSilent(parsed.data) : null;
}

/** A level's outputs in a few words: the picker's line under each level. */
export function alertLevelSummary(out: AlertLevelOutputs): string {
  const parts: string[] = [];
  if (out.sound === 'loud') parts.push('Loud sound');
  else if (out.sound === 'normal') parts.push('Sounds');
  if (out.notify === 'all') parts.push('notification');
  else if (out.notify === 'proceed') parts.push('notification for proceed asks');
  if (out.push) parts.push('phone push');
  if (out.glow) parts.push('glowing card');
  if (parts.length === 0) return 'No sound, notification or push';
  if (out.repeatMin > 0) parts.push(`again every ${out.repeatMin} min`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
