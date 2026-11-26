// alertConfig.ts — the alert level table (Nov 25 2026): what each level (Silent … Urgent) does, and the default level of a
// session that has none of its own and is in no room with one. The rules are src/lib/attention.ts; this keeps the table
// the person edited in Settings, so a phone push (decided here) and every window's sounds read the same one.
//
// Saved in its own small file beside server-config.json, written atomically, read once and kept in memory. A file that
// is missing or unreadable is the defaults; a row with a wrong field keeps the default's for that field.

import { randomBytes } from 'crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_ALERT_CONFIG,
  parseAlertConfig,
  resolveAlertLevel,
  roomAlertLevelOf,
  type AlertConfig,
  type AlertLevel,
  type AlertLevelCarrier,
  type AlertLevelOutputs,
} from '../src/lib/attention.js';
import type { Room } from '../src/types/room.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function configFile(): string {
  if (process.env.AASC_ALERT_LEVELS_FILE) return process.env.AASC_ALERT_LEVELS_FILE;
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'alert-levels.json')
    : join(__dirname, '..', 'data', 'alert-levels.json');
}

let cached: AlertConfig | null = null;

/** The table: read from its file once, then kept in memory. */
export function getAlertConfig(): AlertConfig {
  if (cached === null) {
    try {
      cached = parseAlertConfig(JSON.parse(readFileSync(configFile(), 'utf8')));
    } catch {
      cached = DEFAULT_ALERT_CONFIG;
    }
  }
  return cached;
}

/**
 * Save a whole table: write a temporary file, then rename it over the table. The caller has validated it
 * (readAlertConfigBody). The temporary name is random and the file is created new (`wx`), so nothing planted beside the
 * table is written through, and the saved table is always a fresh file only this user reads (Nov 25 2026).
 */
export function setAlertConfig(config: AlertConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify(config)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    if (created) rmSync(tmp, { force: true });
    throw err;
  }
  cached = config;
}

/** The level a session follows when it has none of its own: its room's, else the default. */
export function followedAlertLevel(sessionId: string, rooms: readonly Room[]): AlertLevel {
  return roomAlertLevelOf(sessionId, rooms) ?? getAlertConfig().defaultLevel;
}

/** A session's level: its own, else its room's, else the default. */
export function alertLevelOf(session: AlertLevelCarrier & { sessionId: string }, rooms: readonly Room[]): AlertLevel {
  const config = getAlertConfig();
  return resolveAlertLevel(session, roomAlertLevelOf(session.sessionId, rooms), config.defaultLevel);
}

/** What a session's level does, from the table. */
export function alertOutputsOf(session: AlertLevelCarrier & { sessionId: string }, rooms: readonly Room[]): AlertLevelOutputs {
  return getAlertConfig().levels[alertLevelOf(session, rooms)];
}

/** Test seam: forget the cached table so the next read goes to the file. */
export function _resetAlertConfigForTests(): void {
  cached = null;
}
