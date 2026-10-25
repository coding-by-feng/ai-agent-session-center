/**
 * @module backgroundTasks
 * Claude Code's Background list for a session (Oct 25 2026): the agents, teammates and shells its
 * terminal panel shows ("82 agents · 1 active shell"). Claude sends the list as `background_tasks`
 * on every Stop; sessionStore used to keep only two counts from it. This keeps a checked, capped
 * copy on the session so the phone's Agents tab can show it.
 *
 * Shells come first (there are usually one or two, and they would be buried under dozens of
 * teammates); the list is capped so a big team doesn't bloat every `session_update`, but the
 * totals count everything Claude sent. Claude sends no start time, so each id keeps the time of
 * the first Stop that listed it.
 */
import type { BackgroundItem, BackgroundTasks } from '../src/types/session.js';

/** Items kept per session. */
export const BACKGROUND_TASKS_KEEP = 50;
export const BACKGROUND_DESCRIPTION_CAP = 160;
export const BACKGROUND_COMMAND_CAP = 500;
const ID_CAP = 64;
const TYPE_CAP = 32;
const STATUS_CAP = 32;

/** `background_tasks` statuses that mean the work is over (shared with sessionStore's queue hold). */
export const FINISHED_TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'done', 'exited']);

const text = (v: unknown, cap: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, cap) : null;
};

/**
 * The session's new Background list from a Stop's `background_tasks`, or undefined when the hook
 * sent none (older CLIs): then the session keeps what it had.
 */
export function toBackgroundTasks(raw: unknown, prev: BackgroundTasks | null | undefined, now: number): BackgroundTasks | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Map((prev?.items ?? []).map((t) => [t.id, t.firstSeenAt]));
  const all: BackgroundItem[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = text(e.id, ID_CAP);
    if (!id) continue;
    const type = text(e.type, TYPE_CAP) ?? 'unknown';
    all.push({
      id,
      type,
      status: text(e.status, STATUS_CAP) ?? '',
      description: text(e.description, BACKGROUND_DESCRIPTION_CAP),
      command: type === 'shell' ? text(e.command, BACKGROUND_COMMAND_CAP) : null,
      firstSeenAt: seen.get(id) ?? now,
    });
  }
  const shells = all.filter((t) => t.type === 'shell');
  const others = all.filter((t) => t.type !== 'shell');
  return {
    items: [...shells, ...others].slice(0, BACKGROUND_TASKS_KEEP),
    agents: others.length,
    shells: shells.length,
    activeShells: shells.filter((t) => !FINISHED_TASK_STATUSES.has(t.status)).length,
    at: now,
  };
}
