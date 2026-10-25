/**
 * pinnedRespawn — keeps PINNED sessions alive.
 *
 * When a pinned session's process dies unexpectedly (status → 'ended' while it is
 * still pinned), this relaunches the same session (same project, command, title,
 * resuming the conversation when possible). A crash-loop guard caps how many
 * respawns happen in a rolling window so a session that dies on every start
 * doesn't spin forever.
 *
 * The crash-loop cap is keyed by a STABLE identity (projectPath + title), not the
 * sessionId, because a respawned session can come back under a new id (a fresh
 * `term-*` session always does), so a per-id counter would never accumulate.
 *
 * A deliberate kill is told apart from a death without any client-side flag: the
 * kill route unpins the session on the server BEFORE it terminates anything, so
 * every ENDED broadcast a kill causes already says `pinned: false`, on every
 * device. The backoff timer holds a snapshot taken at the moment of death, so
 * when it fires it re-reads the live store and only relaunches a card that is
 * still there, still ended and still pinned — a card that was closed, unpinned,
 * revived or removed in the meantime is left alone. The new session is built from
 * that live card, not the snapshot, so a change made during the backoff (Hands off,
 * a central marker, a rename) is not lost.
 */
import type { Session } from '@/types/session';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';

/** Max respawn attempts allowed within WINDOW_MS before we give up. */
export const MAX_ATTEMPTS = 3;
/** Rolling window for the attempt cap. */
export const WINDOW_MS = 60_000;
/** Backoff before the Nth attempt (index 0,1,2 → 2s, 4s, 8s). */
export function backoffMs(priorAttempts: number): number {
  return Math.min(8_000, 2_000 * 2 ** priorAttempts);
}

/** Stable identity for the crash-loop cap — survives id changes across respawns. */
export function respawnKey(session: Session): string {
  return `${session.projectPath || ''}\0${session.title || ''}`;
}

interface RespawnState {
  /** Timestamps (ms) of recent respawn attempts, pruned to WINDOW_MS. */
  attempts: number[];
  /** Pending backoff timer id, if a respawn is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, RespawnState>();
/** Test seam: overridable clock. */
let _now: () => number = () => Date.now();

function getState(key: string): RespawnState {
  let s = states.get(key);
  if (!s) { s = { attempts: [], timer: null }; states.set(key, s); }
  return s;
}

/**
 * Build the POST body to recreate a (now-dead) session. Mirrors the per-session
 * create body in workspaceSnapshot.importSnapshot: a real CLI session id is
 * resumed via `resumeSessionId`; a raw `term-*` command with shell metacharacters
 * is routed through `startupCommand` so the server's command validator accepts it.
 */
export function buildRespawnBody(session: Session): Record<string, unknown> | null {
  const cfg = session.sshConfig;
  if (!cfg) return null;
  const originalId = session.sessionId || '';
  const looksLikeRealSessionId =
    !!originalId && !originalId.startsWith('term-') && /^[a-zA-Z0-9_-]+$/.test(originalId);

  let payloadCommand = cfg.command || 'claude';
  let payloadStartupCommand = session.startupCommand || undefined;
  const hasRawCommand = !!cfg.command && cfg.command.trim().length > 0;
  if (!looksLikeRealSessionId && hasRawCommand) {
    if (!payloadStartupCommand) payloadStartupCommand = cfg.command;
    payloadCommand = '';
  }

  return {
    host: cfg.host || 'localhost',
    port: cfg.port || 22,
    username: cfg.username,
    authMethod: cfg.authMethod,
    privateKeyPath: cfg.privateKeyPath,
    workingDir: cfg.workingDir || '~',
    command: payloadCommand,
    sessionTitle: session.title,
    startupCommand: payloadStartupCommand,
    permissionMode: session.permissionMode || undefined,
    // Preserve the session's effort/model so an auto-respawned pinned session
    // relaunches at the same effort it was created with (matches the workspace
    // restore path in workspaceSnapshot.importSnapshot).
    effortLevel: session.effortLevel || undefined,
    model: session.model || undefined,
    originalSessionId: originalId || undefined,
    resumeSessionId: looksLikeRealSessionId ? originalId : undefined,
    pinned: true,
    accentColor: session.accentColor || undefined,
    characterModel: session.characterModel || undefined,
    // A respawned clone/fork keeps its kill-guard so killing it later can't
    // SIGTERM the origin's claude process (they share projectPath).
    isFork: session.isFork || undefined,
    originSessionId: session.originSessionId || undefined,
    // A central (server/mcp) comes back as the same central: the server mints it again under this id,
    // with a new token for the new terminal. Never set on a clone or fork.
    central: session.central ? { ...session.central } : undefined,
    // The person's hands-off switch (server/mcp) survives a crash: the respawned card is the same session, and
    // a central may not steer it any more than it could before. Only ever `true`: absent means steerable.
    handsOff: session.handsOff === true ? true : undefined,
  };
}

/**
 * True when this ended session is eligible for an automatic respawn.
 * Floating PiP popups are excluded — they only make sense attached to a live
 * origin session. Clone/fork sessions (isFork without isFloating) are regular
 * pinnable sessions and DO respawn.
 */
export function shouldRespawn(session: Session): boolean {
  return !!session.pinned && !session.isFloating && !!session.sshConfig;
}

/**
 * Re-read the store when the backoff ends: the copy we scheduled with is from the
 * moment of death, and the card may have been closed, unpinned or revived since.
 * Answers the LIVE card when it is still wanted (the respawn is built from it, so a
 * change made during the 2–8 s backoff — Hands off, a central marker, a rename —
 * reaches the new session), or null when it is not.
 */
function liveCardToRespawn(session: Session): Session | null {
  const live = useSessionStore.getState().sessions.get(session.sessionId);
  return live && live.status === 'ended' && shouldRespawn(live) ? live : null;
}

/** `attempts` without one entry stamped `at` — a respawn that was skipped is not a respawn. */
function withoutAttempt(attempts: number[], at: number): number[] {
  const i = attempts.lastIndexOf(at);
  return i === -1 ? attempts : [...attempts.slice(0, i), ...attempts.slice(i + 1)];
}

/** Relaunches `session`, which is the live card `liveCardToRespawn` just read — never the copy taken at death. */
async function doRespawn(session: Session): Promise<void> {
  const body = buildRespawnBody(session);
  if (!body) return;
  const name = session.title?.trim() || session.sessionId.slice(0, 6);
  try {
    const res = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
    showToast(`[${name}] Pinned session died — respawning…`, 'info', 2500);
  } catch {
    showToast(`[${name}] Pinned respawn failed — will retry on next death`, 'error', 3000);
  }
}

/**
 * Call when a session transitions to 'ended'. Schedules a respawn (with backoff)
 * for eligible pinned sessions, honoring the crash-loop cap. No-op otherwise.
 */
export function onSessionEnded(session: Session): void {
  if (!shouldRespawn(session)) return;

  const key = respawnKey(session);
  const st = getState(key);
  const now = _now();
  st.attempts = st.attempts.filter((t) => now - t < WINDOW_MS);
  if (st.attempts.length >= MAX_ATTEMPTS) {
    const name = session.title?.trim() || session.sessionId.slice(0, 6);
    showToast(`[${name}] Pinned session died ${MAX_ATTEMPTS}× in a minute — giving up. Unpin or re-pin to retry.`, 'error', 5000);
    return;
  }
  const priorAttempts = st.attempts.length;
  st.attempts.push(now);
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    const live = liveCardToRespawn(session);
    if (!live) {
      // Nothing was relaunched, so this death must not count toward the crash-loop
      // cap (a /clear re-key or a ✕ during the backoff would otherwise fill it).
      st.attempts = withoutAttempt(st.attempts, now);
      return;
    }
    void doRespawn(live);
  }, backoffMs(priorAttempts));
}

/** Test-only reset + clock injection. */
export function _resetForTests(clock?: () => number): void {
  for (const s of states.values()) if (s.timer) clearTimeout(s.timer);
  states.clear();
  _now = clock ?? (() => Date.now());
}
