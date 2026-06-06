/**
 * Derives a default name for Claude Code's `/remote-control` slash command.
 *
 * Preference order:
 *   1. Trimmed session title (if non-empty).
 *   2. `<projectBasename>-<n>` where n increments past existing sessions
 *      sharing the same project basename.
 *
 * The name is sanitized to match the server-side regex
 * `^[a-zA-Z0-9_.\-]+$` (alphanumeric, dash, underscore, dot).
 */

import type { Session } from '@/types';

const NAME_SAFE_RE = /[^a-zA-Z0-9_.-]+/g;

const STORAGE_KEY = 'remote-control:settings';

interface PersistedSettings {
  enabled: boolean;
  /**
   * When true, the "Enable Remote Control" checkbox in session-creation modals
   * is pre-checked whenever the command starts with `claude`, regardless of
   * the user's last manual choice.
   */
  autoEnable?: boolean;
  /** Last manually-edited name — used as a hint only, not auto-applied. */
  lastName?: string;
}

export function loadRemoteControlSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false, autoEnable: false };
    const parsed = JSON.parse(raw) as PersistedSettings;
    return {
      enabled: !!parsed.enabled,
      autoEnable: !!parsed.autoEnable,
      lastName: parsed.lastName,
    };
  } catch {
    return { enabled: false, autoEnable: false };
  }
}

export function saveRemoteControlSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore quota errors */ }
}

function sanitize(name: string): string {
  return name.trim().replace(NAME_SAFE_RE, '-').replace(/^-+|-+$/g, '');
}

function projectBasename(workingDir: string): string {
  const cleaned = workingDir.replace(/\/+$/, '');
  const last = cleaned.split('/').filter(Boolean).pop() ?? '';
  if (!last || last === '~') return 'session';
  return sanitize(last) || 'session';
}

/**
 * Returns the next index to use for a project basename, based on existing
 * sessions whose workingDir basename matches.  At least 1.
 */
function nextIndexForProject(basename: string, sessions: Iterable<Session>): number {
  let count = 0;
  for (const s of sessions) {
    if (!s.projectPath) continue;
    if (projectBasename(s.projectPath) === basename) count += 1;
  }
  return count + 1;
}

export function deriveRemoteControlName(
  sessionTitle: string,
  workingDir: string,
  sessions: Iterable<Session>,
): string {
  const fromTitle = sanitize(sessionTitle);
  if (fromTitle) return fromTitle;
  const base = projectBasename(workingDir);
  return `${base}-${nextIndexForProject(base, sessions)}`;
}

export { sanitize as sanitizeRemoteControlName };

// ---------------------------------------------------------------------------
// Session creation prefs (model + effort level) — shared by both modals
// ---------------------------------------------------------------------------

const SESSION_PREFS_KEY = 'session-create-prefs';

/**
 * Claude Code effort levels (newest feature, Opus 4.8/4.7).
 * `xhigh` is the extended level above `high`; `max` is the highest level the
 * `--effort` launch flag accepts. `ultracode` is a Claude Code menu-only level
 * (xhigh effort + standing multi-agent permission) — the `--effort` flag rejects
 * it, so it is applied via a post-startup `/effort ultracode` slash command.
 * `min` (an older value) was removed because it is not a valid `/effort` level.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
export const DEFAULT_EFFORT_LEVEL = 'high';

/** Coerce a possibly-stale stored value to a valid level, falling back to the default. */
export function normalizeEffortLevel(value: string | undefined): string {
  return value && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? value
    : DEFAULT_EFFORT_LEVEL;
}

interface SessionPrefs {
  model?: string;
  effortLevel?: string;
}

export function loadSessionPrefs(): SessionPrefs {
  try {
    const raw = localStorage.getItem(SESSION_PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SessionPrefs;
  } catch {
    return {};
  }
}

export function saveSessionPrefs(prefs: SessionPrefs): void {
  try {
    localStorage.setItem(SESSION_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* ignore quota errors */ }
}
