/**
 * sessionRestart — "quit and reconnect with the same session", for the terminal
 * toolbar's Restart button (POST /api/sessions/:id/restart-terminal).
 *
 * The agent in the card's terminal is stopped, a FRESH PTY is opened where the
 * old one was, and the session's resume command (same id, title, model, effort,
 * permission mode — built by the route's `buildResumeCommand`) is typed into it
 * once its shell is ready. The card is the same card throughout: it goes to
 * CONNECTING, is re-linked to the new terminal, and is never ended, re-created
 * or unpinned, so no client has anything to respawn.
 *
 * Why a fresh PTY rather than re-typing into the same shell: a launch line is
 * often `claude --resume 'id' || claude`. Stop the first `claude` with the shell
 * still alive and the shell happily starts the fallback one. Closing the PTY ends
 * that chain, and it is the same path RECONNECT / RESUME already take for an
 * ended card (apiRouter's `/resume` and `/reconnect-terminal`).
 *
 * Order matters. The replacement PTY is opened FIRST, so a directory the shell
 * cannot enter or a spawn failure costs nothing: the running agent is untouched.
 * Only then is the old agent stopped, and it must be confirmed DEAD before the new
 * one is typed (two agents on one transcript corrupt it). The old terminal's hooks
 * are dropped from the moment the stop begins (sessionStore.handleEvent).
 */
import {
  beginSessionRestart,
  failSessionRestart,
  getAllSessions,
  getSession,
  reconnectSessionTerminal,
  resolveSessionId,
  setSessionPinned,
} from './sessionStore.js';
import {
  closeTerminal,
  closeTerminalAndWait,
  consumePendingLink,
  createTerminal,
  getTerminalRelaunchSettings,
  getTerminals,
  injectClaudeCommandsWhenReady,
  isTmuxBackedTerminal,
  maybeInjectUltracode,
  writeWhenReady,
} from './sshManager.js';
import { refreshPendingSessionUpdate } from './hookProcessor.js';
import { WS_TYPES } from './constants.js';
import log from './logger.js';
import type { TerminalConfig } from '../src/types/terminal.js';
import type { Session } from '../src/types/session.js';

export type RestartOutcome =
  | { ok: true; terminalId: string; session: Session }
  | { ok: false; status: 404 | 409 | 500; error: string };

/** Sessions with a restart in flight — a double click must not stop the new agent the first one starts. */
const restarting = new Set<string>();
/** Sessions a kill is in the middle of: a restart must not re-link a card that is being closed. */
const closing = new Map<string, number>();

/** True while a restart of this card is running; kill / resume / reconnect / delete refuse meanwhile. */
export function isSessionRestarting(sessionId: string): boolean {
  return restarting.has(resolveSessionId(sessionId) ?? sessionId);
}

/**
 * Mark a card as being closed (the kill route holds it from its first line until the response is
 * sent) so a restart that arrives mid-kill refuses instead of resurrecting it. Returns the release.
 * Counted, so two overlapping holds on one card do not release each other.
 */
export function holdSessionClosing(sessionId: string): () => void {
  const id = resolveSessionId(sessionId) ?? sessionId;
  closing.set(id, (closing.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (closing.get(id) ?? 1) - 1;
    if (left <= 0) closing.delete(id); else closing.set(id, left);
  };
}

const refuse = (status: 404 | 409 | 500, error: string): RestartOutcome => ({ ok: false, status, error });

/** Single-quote a value for a POSIX shell, the way `shellEscapeSingle` does for ids. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** `cd` into a stored directory. A leading `~` must stay outside the quotes or the shell never expands it. */
function cdInto(dir: string): string {
  if (dir === '~') return 'cd ~';
  if (dir.startsWith('~/')) return `cd ~/${shellQuote(dir.slice(2))}`;
  return `cd ${shellQuote(dir)}`;
}

async function broadcastSession(session: Session): Promise<void> {
  // An older hook update still waiting out its throttle must not go out after this one.
  refreshPendingSessionUpdate(session.sessionId, session);
  try {
    const { broadcast } = await import('./wsManager.js');
    broadcast({ type: WS_TYPES.SESSION_UPDATE, session });
  } catch (err: unknown) {
    log.warn('restart', `Failed to broadcast restarted session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Give up on a restart that already began stopping the old agent: the replacement
 * terminal is closed, the card is left ENDED (RESUME applies) and every device is told.
 * `unpin` is for an agent that outlived SIGKILL: a pinned card that says `ended` makes every
 * client's pinnedRespawn launch a second agent beside the survivor, so — like /kill — it is unpinned.
 */
async function abandon(sessionId: string, oldTerminalId: string, newTerminalId: string, error: string, unpin = false): Promise<RestartOutcome> {
  closeTerminal(newTerminalId);
  if (unpin) setSessionPinned(sessionId, false);
  const ended = failSessionRestart(sessionId, oldTerminalId);
  if (ended) await broadcastSession(ended);
  return refuse(500, error);
}

/**
 * @param sessionId     the card to restart (an older alias is resolved)
 * @param resumeCommand the line to type into the new shell; built from the card's
 *                      state BEFORE the restart, so it still carries title/model/effort
 */
export async function restartSessionTerminal(sessionId: string, resumeCommand: string): Promise<RestartOutcome> {
  const resolvedId = resolveSessionId(sessionId) ?? sessionId;
  const session = getSession(resolvedId);
  if (!session) return refuse(404, 'Session not found');
  if (restarting.has(session.sessionId)) return refuse(409, 'This session is already restarting');
  if (closing.has(session.sessionId)) return refuse(409, 'This session is being closed');
  restarting.add(session.sessionId);
  try {
    return await restartLiveSession(session, resumeCommand);
  } finally {
    restarting.delete(session.sessionId);
  }
}

async function restartLiveSession(session: Session, resumeCommand: string): Promise<RestartOutcome> {
  // A fork's agent reports its hooks under its ORIGIN's session id, and its own id (term-*) is not
  // resumable, so a restart could neither silence the old agent nor bring its conversation back.
  if (session.isFork || session.isFloating) {
    return refuse(409, 'Restart is not available for forked or floating sessions');
  }
  const oldTerminalId = session.terminalId;
  if (!oldTerminalId || !getTerminals().some((t) => t.terminalId === oldTerminalId)) {
    return refuse(409, 'This session has no live terminal to restart — use RECONNECT to open one');
  }
  if (isTmuxBackedTerminal(oldTerminalId)) {
    return refuse(409, 'Restart is not available for tmux sessions: the agent lives in tmux, so closing this terminal would leave it running');
  }
  if (!resumeCommand.trim()) {
    return refuse(409, 'No launch command is known for this session, so there is nothing to restart it with');
  }
  // Closing the terminal stops every process in it: not something to do to a card that shares it.
  const sharer = Object.values(getAllSessions()).find((other) =>
    other.sessionId !== session.sessionId && other.status !== 'ended' && other.terminalId === oldTerminalId);
  if (sharer) {
    return refuse(409, 'This terminal is shared with another live session, so restarting it would stop that one too');
  }

  const cfg = session.sshConfig;
  const isRemote = !!cfg && !!cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1';
  if (isRemote && !cfg?.username) {
    return refuse(409, 'No SSH login is stored for this session, so it cannot be restarted on its remote host');
  }
  if (isRemote && cfg?.authMethod === 'password') {
    return refuse(409, 'Restart is not available for password-authenticated SSH sessions: the password is not stored, so the new connection could not log in');
  }

  // Launch-only settings the Session record does not keep (the API-key override, the Remote Control name).
  const kept = getTerminalRelaunchSettings(oldTerminalId);
  // A local card relaunches where its agent really runs (`projectPath`, corrected from the hook's cwd):
  // `claude --resume` finds its transcript by directory, so the launch directory would not do after a `cd`.
  const workingDir = isRemote ? (cfg?.workingDir || '~') : (session.projectPath || cfg?.workingDir || '~');
  const newConfig: TerminalConfig = {
    ...(cfg && cfg.username ? cfg : { host: 'localhost' }),
    workingDir,
    command: '',
    ...(kept.apiKey ? { apiKey: kept.apiKey } : {}),
  };

  // Open the replacement BEFORE anything is stopped: a directory the shell cannot
  // enter or a spawn failure must leave the running agent alone.
  let newTerminalId: string;
  try {
    // command '' skips auto-launch: the resume line contains `||`, which the
    // terminal command validator rejects, so it is typed below instead.
    newTerminalId = await createTerminal(newConfig, null);
    // Resume matches through pendingResume, not pendingLinks. Naming this terminal
    // removes only a link of its own (none, for an empty command); the bare form
    // would drop the front link of ANOTHER terminal launching in the same directory.
    consumePendingLink(newConfig.workingDir || session.projectPath || '', newTerminalId);
  } catch (err: unknown) {
    log.error('restart', `Could not open a new terminal for ${session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    return refuse(500, 'Could not restart the session: the new terminal failed to open, and the running session was left untouched');
  }

  const begun = beginSessionRestart(session.sessionId);
  if ('error' in begun) {
    closeTerminal(newTerminalId);
    return refuse(409, begun.error);
  }
  await broadcastSession(begun.session);

  // The old agent must be gone before a second one resumes the same transcript.
  const stopped = await closeTerminalAndWait(oldTerminalId);
  if (!stopped) {
    log.error('restart', `Agent in terminal ${oldTerminalId} survived SIGKILL for session ${session.sessionId.slice(0, 8)}`);
    return abandon(session.sessionId, oldTerminalId, newTerminalId, 'The running session could not be stopped, so it was not restarted', true);
  }

  // A kill that began before this restart can finish while it waited. Re-linking then would resurrect a
  // card the user just closed and type an agent into it, so check what the card is NOW.
  const current = getSession(session.sessionId);
  if (!current || current.status === 'ended' || current.terminalId !== oldTerminalId) {
    closeTerminal(newTerminalId);
    return refuse(409, 'The session was closed while it was restarting, so it was left closed');
  }

  const linked = reconnectSessionTerminal(session.sessionId, newTerminalId, { archivePrevious: false });
  if ('error' in linked) {
    return abandon(session.sessionId, oldTerminalId, newTerminalId, `Failed to restart the session: ${linked.error}`);
  }

  // SSH does not forward env vars, so a remote shell is told its terminal id and
  // directory in the line itself (same as resume / reconnect).
  let prefix = '';
  if (isRemote) {
    prefix += `export AGENT_MANAGER_TERMINAL_ID=${shellQuote(newTerminalId)} && `;
    if (cfg?.workingDir) prefix += `${cdInto(cfg.workingDir)} && `;
  }
  writeWhenReady(newTerminalId, `${prefix}${resumeCommand}\r`);
  if (kept.remoteControlName && resumeCommand.startsWith('claude')) {
    // One injector for both slash commands, so they cannot interleave. The name was validated when the session was launched.
    injectClaudeCommandsWhenReady(newTerminalId, [
      ...(session.effortLevel === 'ultracode' ? ['/effort ultracode'] : []),
      `/remote-control ${kept.remoteControlName}`,
    ]);
  } else {
    maybeInjectUltracode(newTerminalId, session.effortLevel, resumeCommand);
  }

  await broadcastSession(linked.session);
  log.info('restart', `Restarted session ${session.sessionId.slice(0, 8)}: ${oldTerminalId.slice(0, 12)} → ${newTerminalId.slice(0, 12)}`);
  return { ok: true, terminalId: newTerminalId, session: linked.session };
}
