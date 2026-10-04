/**
 * @module launchSession
 * Start a local Claude / Codex session in a directory. It is the one request
 * the DIRS launcher and the session strip's project frames both make, so the
 * parts around it (select the new card, tell the user) cannot drift apart
 * between the two.
 *
 * `forceNew` is the difference between them. The server answers a request whose
 * host, directory and command match a live session by returning THAT session
 * (`deduplicated: true`), which is right for a "relaunch this directory" menu
 * and wrong for a "new session in this project" button, which has to start one.
 * `requireExistingDir` is the other: the server starts a shell in the home
 * directory when the one asked for is gone, which a project frame must not get.
 */
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';

export interface LaunchRequest {
  workingDir: string;
  /** The CLI to run, `'claude'` or `'codex'`. */
  command: string;
  /** Always start a new session, even if one already runs this CLI in this directory. */
  forceNew?: boolean;
  /** Fail, rather than start in the home directory, if `workingDir` does not exist. */
  requireExistingDir?: boolean;
}

export type LaunchResult =
  | { ok: true; terminalId: string | undefined; deduplicated: boolean }
  | { ok: false; error: string };

interface LaunchReply {
  ok?: boolean;
  error?: string;
  terminalId?: string;
  deduplicated?: boolean;
}

/** The last folder of a path, for toasts and labels: `'/Users/me/app/'` → `'app'`. */
export function shortenPath(fullPath: string): string {
  const normalized = fullPath.replace(/\/+$/, '');
  // Stripping the trailing slashes empties the root; keep it readable.
  if (normalized === '' && fullPath.startsWith('/')) return '/';
  if (normalized === '~') return normalized;
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

/**
 * What the server refuses in a `workingDir` (`noShellMetaWorkDir` in
 * server/apiRouter.ts), copied because the renderer cannot import from `server/`.
 * `launchSession.test.ts` compares it against the server's own source, so the two
 * cannot drift apart unnoticed.
 */
const SHELL_META_RE = /[;|&$`\\!><()\n\r{}[\]]/;
export const MAX_WORKING_DIR_LENGTH = 1024;
const SHOWN_AS: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r' };

/**
 * Why a launch in `workingDir` would be refused before it starts, or null when
 * nothing about the path is. A folder like `~/Projects/site (old)` is an ordinary
 * thing to have, and every click on its chip would otherwise end in a toast about
 * "invalid shell characters".
 */
export function launchBlocker(workingDir: string): string | null {
  if (workingDir.length > MAX_WORKING_DIR_LENGTH) {
    return `the path is longer than ${MAX_WORKING_DIR_LENGTH} characters`;
  }
  const offending = new Set(workingDir.replace(/^~/, '').match(new RegExp(SHELL_META_RE.source, 'g')) ?? []);
  if (offending.size === 0) return null;
  const shown = [...offending].map((c) => SHOWN_AS[c] ?? c).join(' ');
  return `the path contains ${shown}, which the server refuses in a working directory`;
}

/**
 * Launches in flight, by directory and CLI. A frame that remounts mid-request (the
 * view or the room filter changes) starts with fresh buttons, and every accepted
 * `forceNew` request starts a PTY, so the second click must be refused here, not
 * only by the component that sent the first.
 */
const inFlight = new Set<string>();

/**
 * Ask the server for a session running `command` in `workingDir`, select it
 * once it exists, and report the outcome to the user. Never throws: a failure
 * comes back as `{ ok: false, error }` after the toast has been shown.
 */
export async function launchSession({
  workingDir,
  command,
  forceNew,
  requireExistingDir,
}: LaunchRequest): Promise<LaunchResult> {
  const folder = shortenPath(workingDir);
  const flight = `${workingDir}\u0000${command}`;
  if (inFlight.has(flight)) {
    const error = `Already starting ${command} in ${folder}`;
    showToast(error, 'info');
    return { ok: false, error };
  }
  inFlight.add(flight);

  // No host or username: the server spawns a local PTY for a request without them.
  const body = {
    workingDir,
    command,
    ...(forceNew ? { forceNew: true } : {}),
    ...(requireExistingDir ? { requireExistingDir: true } : {}),
  };

  try {
    const res = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as LaunchReply;

    if (!data.ok) {
      const error = data.error || 'Failed to launch session';
      showToast(error, 'error');
      return { ok: false, error };
    }

    const reused = !!data.deduplicated;
    // Select it so the detail panel follows the new session. The card itself
    // arrives over the WebSocket a moment later; the selection waits for it.
    // Not when it is the session already on screen: selecting records the one
    // being left as the "previous" session, and a session that is its own
    // previous breaks the go-back shortcut.
    if (data.terminalId && useSessionStore.getState().selectedSessionId !== data.terminalId) {
      useSessionStore.getState().selectSession(data.terminalId);
    }
    if (reused) showToast(`${command} is already running in ${folder}`, 'info');
    else showToast(`Launched ${command} in ${folder}`, 'success');
    return { ok: true, terminalId: data.terminalId, deduplicated: reused };
  } catch {
    const error = 'Network error launching session';
    showToast(error, 'error');
    return { ok: false, error };
  } finally {
    inFlight.delete(flight);
  }
}
