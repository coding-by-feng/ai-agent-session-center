// shareDefault.ts — "Share new sessions with my devices" (Oct 2026, by request).
//
// Off by default, because sharing shows a session to every paired phone and remote sign-in.
// On, every session that appears on this Mac starts shared (`remoteVisible: true`), so the
// person needn't press 📡 SHARE on each one. A choice saved for one session (a restore that
// carries `remoteVisible` true or false) always wins over the default: hiding a session stays
// hidden across a restart even while this is on. Only this Mac may change it (apiRouter).
//
// Saved in its own small file beside server-config.json, written atomically.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function settingFile(): string {
  if (process.env.AASC_SHARE_DEFAULT_FILE) return process.env.AASC_SHARE_DEFAULT_FILE;
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'share-default.json')
    : join(__dirname, '..', 'data', 'share-default.json');
}

let cached: boolean | null = null;

/** Is the setting on? Read from its file once, then kept in memory. */
export function isShareNewSessionsOn(): boolean {
  if (cached === null) {
    try {
      cached = (JSON.parse(readFileSync(settingFile(), 'utf8')) as { shareNewSessions?: unknown }).shareNewSessions === true;
    } catch {
      cached = false;
    }
  }
  return cached;
}

/** Turn the setting on or off, and save it (write to a temp file, then rename). */
export function setShareNewSessions(on: boolean): void {
  const file = settingFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ shareNewSessions: on })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cached = on;
}

/**
 * A new session's `remoteVisible`: the choice saved for it (true or false) when there is one,
 * else true while the setting is on, else undefined (hidden — the safe state, see sessionVisibility.ts).
 */
export function initialRemoteVisible(saved: boolean | null | undefined): boolean | undefined {
  if (saved === true || saved === false) return saved;
  return isShareNewSessionsOn() ? true : undefined;
}

/** Test seam: forget the cached value so the next read goes to the file. */
export function _resetShareNewSessionsForTests(): void {
  cached = null;
}
