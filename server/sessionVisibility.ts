/**
 * sessionVisibility — which sessions a given client is allowed to see.
 *
 * Kept pure and import-free (no Express, no ws, no session store) so the rule
 * can be unit-tested directly and reused from both the HTTP and WebSocket
 * boundaries without either importing the other.
 *
 * ## The rule
 *
 * A session reaches a REMOTE device only if it has been explicitly opted in.
 * Localhost — the machine running the server — always sees everything, so the
 * desktop app is completely unaffected by this feature.
 *
 * ## Why the default is deny
 *
 * The dashboard binds `0.0.0.0` and is reachable from any device on the LAN.
 * A password now gates *access*, but every authenticated device previously saw
 * every session: content, transcripts, live PTY output, and the controls to
 * kill or fork. Opting a session IN is a deliberate act; opting one OUT is
 * something a user would have to remember to do for each new session, forever.
 * Only the first ordering fails safe.
 *
 * ## Why `remoteVisible` is checked, never `!hidden`
 *
 * The flag is stored as "may be seen remotely", so a session that predates the
 * feature — with the column NULL and the field `undefined` — is hidden. A
 * `hidden` flag would have inverted that: every existing row would read as
 * "not hidden" and be exposed the moment the feature shipped. The absent state
 * must be the safe state, because that is the state of every row written
 * before this code existed.
 */

/** The only fields of a session this module needs. Structural, so a full
 *  Session, a DB row, or a test fixture all satisfy it. */
export interface VisibilityCandidate {
  /** True when the user has opted this session into remote viewing.
   *  Absent (pre-feature rows, newly created sessions) means NO. */
  remoteVisible?: boolean | null;
}

/**
 * May a client on this device see this session?
 *
 * `isLocalClient` must come from `isLoopbackAddress` — the same predicate
 * backing the auth gate and the 🖥/📱 device split — never a second hand-rolled
 * address comparison, so all three agree about what "this machine" means.
 *
 * A missing session (`null`/`undefined`) is NOT visible: a remote client asking
 * about an id that does not exist must not be able to distinguish "no such
 * session" from "hidden from you", or the 404/403 split becomes an enumeration
 * oracle for session ids.
 */
export function canSeeSession(
  isLocalClient: boolean,
  session: VisibilityCandidate | null | undefined,
): boolean {
  if (isLocalClient) return true;
  if (!session) return false;
  return session.remoteVisible === true;
}

/**
 * The subset of a session map/record this client may see.
 *
 * Returns the input object unchanged for a local client — the overwhelmingly
 * common case is the desktop app, and rebuilding a 50-entry record on every
 * broadcast would add work to the hottest path in the server for no effect.
 */
export function filterVisibleSessions<T extends VisibilityCandidate>(
  isLocalClient: boolean,
  sessions: Record<string, T>,
): Record<string, T> {
  if (isLocalClient) return sessions;
  const out: Record<string, T> = {};
  for (const [id, session] of Object.entries(sessions)) {
    if (canSeeSession(false, session)) out[id] = session;
  }
  return out;
}

/** How many sessions are being withheld — surfaced in the UI so a remote user
 *  sees "18 hidden" rather than concluding the dashboard is broken. */
export function countHiddenSessions<T extends VisibilityCandidate>(
  isLocalClient: boolean,
  sessions: Record<string, T>,
): number {
  if (isLocalClient) return 0;
  let n = 0;
  for (const session of Object.values(sessions)) {
    if (!canSeeSession(false, session)) n++;
  }
  return n;
}
