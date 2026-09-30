/**
 * remoteControlDaemon — keep a session's Claude Code Remote Control link fresh.
 *
 * Claude Code's `/remote-control <name>` is injected once at session start
 * (`sshManager.ts`, from `config.remoteControlName`) and never touched again,
 * so a link that goes stale stays stale and the session quietly stops
 * appearing as live in the Claude Code app. Armed sessions get the link cycled
 * — `/remote-control` to disconnect, then `/remote-control <name>` to
 * reconnect — whenever the session goes idle.
 *
 * The two commands are confirmed against the Claude Code binary's own strings:
 * "Disconnect anytime with /remote-control" (bare = disconnect) and
 * "You can always enable it later with /remote-control" — the NAME is only
 * meaningful on the enable half.
 *
 * ## The self-retrigger hazard, and why a cooldown is the fix
 *
 * Writing to the PTY is input. Input moves the session out of `idle`, and it
 * lands back in `idle` minutes later — which is the very condition that
 * started the cycle. Left alone this is an unattended loop typing slash
 * commands into the user's session forever.
 *
 * Two things stop it, and BOTH are needed:
 *   1. Edge-triggering — `noteStatusChange` fires only on a transition INTO
 *      idle, never for each tick of a session that is merely sitting idle.
 *   2. The cooldown — the relink's own idle→working→idle round trip completes
 *      in far under COOLDOWN_MS, so the idle edge it causes is suppressed.
 *
 * Edge-triggering alone is not enough (the cycle produces a real edge), and
 * the cooldown alone is not enough (a long-idle session would re-fire every
 * cooldown window forever).
 */
import log from './logger.js';

/**
 * Characters Claude Code's `/remote-control <name>` accepts, mirrored from
 * `NAME_SAFE_RE` in `src/lib/remoteControlName.ts`.
 *
 * DUPLICATED, not imported: `tsconfig.server.json` includes only `server` and
 * `src/types`, so the server cannot reach `src/lib`. This is the same
 * constraint (and the same remedy) as `ptyRing.ts` and the session-name
 * quoting mirror — a test asserts the two regexes stay identical, since drift
 * here produces a name the server rejects with a 400 and no obvious cause.
 */
export const NAME_SAFE_RE = /[^a-zA-Z0-9_.-]+/g;
/** Server-side cap on `remoteControlName` (apiRouter's Zod schema). */
export const MAX_NAME_LEN = 100;

/** Reduce arbitrary text to a valid remote-control name. May return ''. */
export function sanitizeName(name: string): string {
  return name.trim().replace(NAME_SAFE_RE, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LEN);
}

/**
 * The name to relink a session under, derived from its CURRENT title.
 *
 * This is the half that fixes the reported mismatch. `deriveRemoteControlName`
 * runs only in the session-creation modals, against the modal's title field —
 * but `session.title` stays empty until the first `UserPromptSubmit`, so the
 * link is almost always named `<project>-<n>` and never tracks the real title.
 * Re-deriving at relink time is what makes the name follow the session.
 *
 * The fallback chain matters as much as the happy path: a title made entirely
 * of CJK (or any non-`[A-Za-z0-9_.-]` script) sanitizes to the EMPTY string,
 * which would otherwise emit a bare `/remote-control` — i.e. silently
 * DISCONNECT instead of reconnecting, the exact opposite of the intent.
 */
export function remoteControlNameFor(session: {
  sessionId: string;
  title?: string;
  projectName?: string;
}): string {
  return sanitizeName(session.title ?? '')
    || sanitizeName(session.projectName ?? '')
    || `session-${session.sessionId.slice(0, 8)}`;
}

/** How long after a relink before the same session may relink again. */
export const COOLDOWN_MS = 30 * 60 * 1000;
/** Pause between the disconnect and the re-enable, so the CLI processes the
 *  first command before the second arrives. */
export const RELINK_GAP_MS = 1200;

/** Per-session daemon state. Absent = never armed. */
export interface DaemonEntry {
  armed: boolean;
  /** When the last relink was ISSUED (not completed). Drives the cooldown. */
  lastRelinkAt: number;
  /** Total relinks, surfaced in the UI so the user can see it working. */
  relinkCount: number;
}

const entries = new Map<string, DaemonEntry>();

const DEFAULT_ENTRY: DaemonEntry = Object.freeze({
  armed: false, lastRelinkAt: 0, relinkCount: 0,
}) as DaemonEntry;

export function getEntry(sessionId: string): DaemonEntry {
  return entries.get(sessionId) ?? DEFAULT_ENTRY;
}

/**
 * Arm or disarm. **Disarming is sticky** — nothing re-arms a session
 * automatically. A watchdog that re-enables what the user explicitly switched
 * off makes the off switch a lie, which is worse than not having one.
 */
export function setArmed(sessionId: string, armed: boolean): void {
  const cur = entries.get(sessionId) ?? DEFAULT_ENTRY;
  entries.set(sessionId, { ...cur, armed });
}

/** Drop a session's state (deletion / re-key cleanup). */
export function forgetSession(sessionId: string): void {
  entries.delete(sessionId);
}

/** Carry state across a `claude --resume` re-key, matching how queue
 *  automation and the control baton migrate. */
export function migrateSession(oldId: string, newId: string): void {
  const cur = entries.get(oldId);
  if (!cur) return;
  entries.delete(oldId);
  if (!entries.has(newId)) entries.set(newId, { ...cur });
}

/**
 * May this session relink right now?
 *
 * Pure apart from the module's own map, and exported so the rule is testable
 * without a PTY: an unarmed session never relinks, and an armed one waits out
 * the cooldown.
 */
export function shouldRelink(sessionId: string, now: number): boolean {
  const e = entries.get(sessionId);
  if (!e?.armed) return false;
  return now - e.lastRelinkAt >= COOLDOWN_MS;
}

/** Record that a relink was issued — call BEFORE writing, so a slow or failed
 *  write can never leave the cooldown unset and allow an immediate retry. */
export function noteRelinked(sessionId: string, now: number): void {
  const cur = entries.get(sessionId) ?? DEFAULT_ENTRY;
  entries.set(sessionId, {
    ...cur, armed: cur.armed, lastRelinkAt: now, relinkCount: cur.relinkCount + 1,
  });
}

/** Test seam: reset all state. */
export function _resetForTests(): void {
  entries.clear();
}

/**
 * The two commands, in order, for one relink cycle.
 *
 * Returned as data rather than written here so the sequencing is testable and
 * the PTY write stays in one place (`runRelink`). The name is only attached to
 * the enable half — the disconnect takes no argument.
 */
export function relinkCommands(name: string): string[] {
  return ['/remote-control', `/remote-control ${name}`];
}

/**
 * Perform a relink against a live terminal.
 *
 * `write` is injected so this can be exercised without a PTY. Returns false
 * without touching the terminal when the session is not due — callers do not
 * need to re-check `shouldRelink` themselves.
 */
export async function runRelink(opts: {
  sessionId: string;
  name: string;
  write: (data: string) => void;
  now?: number;
  gapMs?: number;
}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (!shouldRelink(opts.sessionId, now)) return false;

  // Stamped BEFORE the writes: if the gap below throws, or the process dies
  // between the two commands, the cooldown still holds and the session cannot
  // hammer the CLI on the next idle edge.
  noteRelinked(opts.sessionId, now);

  const [disconnect, reconnect] = relinkCommands(opts.name);
  opts.write(`${disconnect}\r`);
  await new Promise((r) => setTimeout(r, opts.gapMs ?? RELINK_GAP_MS));
  opts.write(`${reconnect}\r`);
  log.info('remote-control', `Relinked ${opts.sessionId.slice(0, 8)} as "${opts.name}"`);
  return true;
}
