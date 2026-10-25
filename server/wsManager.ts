// wsManager.ts — WebSocket broadcast manager with bidirectional terminal support
import {
  getAllSessions,
  getAllTeams,
  getEventSeq,
  getEventsSince,
  updateQueueCount,
  getSessionIdByTerminalId,
  getSession,
} from './sessionStore.js';
import {
  writeToTerminal,
  resizeTerminal,
  getTerminalGeometry,
  clearTerminalOutput,
  setWsClient,
  removeWsClient,
  removeClientFromAllTerminals,
  getTerminalSessionId,
  isOpsTerminal,
  getForegroundProcess,
} from './sshManager.js';
import { isAgentProcessName } from './mobile/phoneProfile.js';
import { bindRemoteClientId } from './clientBinding.js';
import { isLineageAlive } from './authManager.js';
import * as presence from './presenceManager.js';
import { isLoopbackAddress } from './presenceManager.js';
import { canSeeSession, filterVisibleSessions } from './sessionVisibility.js';
import { WS_TYPES } from './constants.js';
import log from './logger.js';
import type WebSocket from 'ws';

interface WsClient extends WebSocket {
  _terminalIds: Set<string>;
  _isAlive: boolean;
  _msgCount: number;
  _msgWindowStart: number;
  /** Which device this socket belongs to (see presenceManager). '' when unidentified. */
  _clientId: string;
  _label: string;
  /** True when this socket came from the machine running the server. Computed
   *  once at connect from the SAME predicate as the auth gate and the device
   *  list, so all three agree on what "this machine" means. */
  _isLocal: boolean;
  /** The paired phone this socket belongs to (AASC-15), so revoking it can close the socket. */
  _deviceId: string | null;
  /** Last time we told this client it lacks control of a session — throttles the notice. */
  _lastDenyAt: Map<string, number>;
}

/** Identity supplied by the client on the WebSocket URL. */
export interface ClientIdentity {
  clientId: string;
  label: string;
  address: string;
  /**
   * Whether the connection is the Mac itself, decided by `isLocalRequest`
   * (requestLocality.ts) on the upgrade request. The peer address alone is not
   * enough: a tunnel on this machine connects from 127.0.0.1 too.
   */
  isLocal?: boolean;
  /** The sign-in lineage of the token this socket authenticated with (remote devices). */
  lineage?: string | null;
  /** Set when the socket authenticated with a session a paired phone obtained (server/mobile). */
  deviceId?: string | null;
}

/**
 * How often a client may be told it lacks control of a given session.
 * `terminal_input` fires per keystroke, so an un-throttled notice would emit one
 * message per character typed by a spectator.
 */
const CONTROL_DENY_NOTICE_MS = 3000;

const clients = new Set<WsClient>();
const MAX_WS_CONNECTIONS = 50;
const MAX_MSG_PER_SECOND = 100;

// Heartbeat: ping every 30s, terminate connections that don't pong within 10s
const HEARTBEAT_INTERVAL_MS = 30000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Backpressure: skip non-critical updates if client buffer exceeds 1MB
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;

// Throttle hook_stats broadcasts to once per second max
let lastHookStatsBroadcastAt = 0;
let pendingHookStats: unknown = null;
let hookStatsTimer: ReturnType<typeof setTimeout> | null = null;
const HOOK_STATS_THROTTLE_MS = 1000;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws._isAlive === false) {
        // Didn't respond to last ping — terminate
        log.info('ws', 'Terminating unresponsive client');
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws._isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (hookStatsTimer) {
    clearTimeout(hookStatsTimer);
    hookStatsTimer = null;
  }
}

/**
 * Handle a new WebSocket connection: send snapshot and wire up message/close handlers.
 */
export function handleConnection(ws: WebSocket, identity?: ClientIdentity): void {
  // Enforce connection limit
  if (clients.size >= MAX_WS_CONNECTIONS) {
    log.warn('ws', `Connection limit reached (${MAX_WS_CONNECTIONS}), rejecting`);
    ws.close(4003, 'Too many connections');
    return;
  }

  const client = ws as WsClient;
  clients.add(client);
  client._terminalIds = new Set();
  client._isAlive = true;
  client._msgCount = 0;
  client._msgWindowStart = Date.now();
  client._clientId = identity?.clientId ?? '';
  // The upgrade handler decides locality with `isLocalRequest` and passes it
  // in. Callers that only know an address (tests) fall back to the loopback
  // check; an unknown address still fails CLOSED (treated as remote).
  client._isLocal = identity?.isLocal ?? isLoopbackAddress(identity?.address ?? '');
  client._label = presence.sanitizeDeviceLabel(identity?.label ?? '');
  client._deviceId = identity?.deviceId ?? null;
  // A remote device must not borrow the desktop's id: that id passes the
  // control check and would demote the desktop to "remote" in presence
  // (AASC-27). It connects as an anonymous socket instead, which can watch but
  // never type.
  if (!client._isLocal && client._clientId && presence.getDevice(client._clientId)?.isLocal) {
    log.warn('ws', 'Remote socket presented a local device id; connecting it anonymously');
    client._clientId = '';
  }
  // Nor another remote device's id: the id belongs to the sign-in that first used it.
  if (!client._isLocal && client._clientId
      && !bindRemoteClientId(client._clientId, identity?.lineage ?? null, isLineageAlive)) {
    log.warn('ws', 'Remote socket presented a device id owned by another sign-in; connecting it anonymously');
    client._clientId = '';
  }
  client._lastDenyAt = new Map();
  if (client._clientId) {
    presence.registerClient({
      clientId: client._clientId,
      label: client._label,
      address: identity?.address ?? '',
      isLocal: client._isLocal,
    });
  }
  log.info('ws', `Client connected (total: ${clients.size})`);

  // Start heartbeat on first connection
  startHeartbeat();

  // Handle pong responses
  client.on('pong', () => {
    client._isAlive = true;
  });

  // Send full snapshot on connect (includes teams + event sequence for replay)
  const allSessions = getAllSessions();
  // Deny by default for anything that is not this machine. The snapshot is the
  // first and largest leak: it carries every session's full state on connect.
  const sessions = filterVisibleSessions(client._isLocal, allSessions);
  const hiddenCount = Object.keys(allSessions).length - Object.keys(sessions).length;
  const teams = getAllTeams();
  const seq = getEventSeq();
  log.debug('ws', `Sending snapshot: ${Object.keys(sessions).length} sessions`
    + `${hiddenCount ? ` (${hiddenCount} hidden from remote)` : ''}`
    + `, ${Object.keys(teams).length} teams, seq=${seq}`);
  // hiddenCount lets the client say "18 hidden" rather than looking broken.
  client.send(JSON.stringify({ type: WS_TYPES.SNAPSHOT, sessions, teams, seq, hiddenCount }));

  // Tell everyone (including this client) who is now connected and what they
  // control, so the joining device knows immediately that it is a spectator and
  // the existing devices see it arrive.
  broadcastPresence();

  // Handle incoming messages (terminal input, resize, etc.)
  client.on('message', (raw: WebSocket.RawData) => {
    // Rate limit: max MAX_MSG_PER_SECOND messages per second per client
    const now = Date.now();
    if (now - client._msgWindowStart > 1000) {
      client._msgWindowStart = now;
      client._msgCount = 0;
    }
    client._msgCount++;
    if (client._msgCount > MAX_MSG_PER_SECOND) {
      log.warn('ws', 'Client message rate limit exceeded, closing');
      client.close(4004, 'Rate limit exceeded');
      return;
    }

    try {
      const rawStr = raw.toString();
      // Reject oversized messages early (512KB)
      if (rawStr.length > 524288) {
        log.warn('ws', 'Oversized WS message rejected');
        return;
      }
      const msg = JSON.parse(rawStr);
      switch (msg.type) {
        case WS_TYPES.TERMINAL_INPUT:
          // Only allow writing to terminals this client is subscribed to
          if (typeof msg.terminalId === 'string' && typeof msg.data === 'string' && msg.data.length <= 262144) {
            if (!client._terminalIds.has(msg.terminalId)) {
              log.warn('ws', `Blocked terminal_input to unsubscribed terminal ${msg.terminalId}`);
              break;
            }
            // Reads are shared across devices; WRITES are not. Two people typing
            // into one PTY interleaves their keystrokes into garbage, so a
            // spectator's input is dropped until it holds the session's baton.
            if (!holdsControl(client, msg.terminalId)) break;
            // A paired phone types only into a running agent: every agent
            // terminal is a login shell underneath, so after the agent exits the
            // same keystrokes would be shell commands (AASC-28).
            if (client._deviceId && !isAgentProcessName(getForegroundProcess(msg.terminalId))) {
              noticeAgentNotRunning(client, msg.terminalId);
              break;
            }
            writeToTerminal(msg.terminalId, msg.data);
          }
          break;
        case WS_TYPES.TERMINAL_RESIZE:
          if (typeof msg.terminalId === 'string'
              && Number.isInteger(msg.cols) && msg.cols > 0 && msg.cols <= 500
              && Number.isInteger(msg.rows) && msg.rows > 0 && msg.rows <= 200) {
            if (!client._terminalIds.has(msg.terminalId)) break;
            // A resize mutates the shared PTY — a phone in portrait would
            // reflow the desktop's terminal to ~40 columns. Same gate as input.
            if (!holdsControl(client, msg.terminalId)) break;
            // #31: Relay resize errors back to client
            const resizeErr = resizeTerminal(msg.terminalId, msg.cols, msg.rows);
            // Every OTHER subscriber is now rendering at a stale width. Tell
            // them all, so a panning phone re-pins to the new size rather than
            // silently clipping or over-padding until it reconnects.
            if (!resizeErr) broadcastGeometry(msg.terminalId);
            if (resizeErr && client.readyState === 1) {
              try { client.send(JSON.stringify({ type: 'terminal_error', terminalId: msg.terminalId, error: `Resize failed: ${resizeErr}` })); } catch { /* ignore */ }
            }
          }
          break;
        case WS_TYPES.TERMINAL_CLEAR:
          // The toolbar's "Clear output". The output is the session's, not this
          // device's: empty the replay ring, then have every subscriber clear on
          // the same message, so the live view, a later replay and the other
          // devices all agree on where the clear happened. It changes what every
          // device sees, so it takes the input gate.
          if (typeof msg.terminalId === 'string' && client._terminalIds.has(msg.terminalId)) {
            if (!holdsControl(client, msg.terminalId)) break;
            if (clearTerminalOutput(msg.terminalId)) broadcastTerminalCleared(msg.terminalId);
          }
          break;
        case WS_TYPES.TERMINAL_DISCONNECT:
          // Unsubscribe this client from terminal output without killing the PTY.
          // The PTY is only destroyed by explicit DELETE /api/terminals/:id or session kill.
          // Remove THIS client only — with multi-device viewing, dropping the
          // whole subscriber set would blank every other device's terminal.
          if (typeof msg.terminalId === 'string' && client._terminalIds.has(msg.terminalId)) {
            removeWsClient(msg.terminalId, client);
            client._terminalIds.delete(msg.terminalId);
          }
          break;
        case WS_TYPES.TERMINAL_SUBSCRIBE:
          // #30/#44: Only subscribe if terminal actually exists
          if (typeof msg.terminalId === 'string') {
            // THE non-obvious leak: terminal subscribe is keyed by
            // terminalId, not session id. Without this check a remote client
            // could hide a session from its own list and still stream the
            // session's live PTY output in full — the card invisible while the
            // content flows. Resolved through the owning session so the rule
            // is the same one the list and REST routes use.
            if (!canSubscribeToTerminal(client, msg.terminalId)) {
              log.warn('ws', `Blocked remote terminal subscribe to ${msg.terminalId} (session hidden)`);
              break;
            }
            const exists = setWsClient(msg.terminalId, client);
            if (exists) {
              client._terminalIds.add(msg.terminalId);
              // Tell the joining client the PTY's real width. A device too
              // narrow to drive the PTY (a phone) renders at this size and
              // pans, instead of soft-wrapping 120 columns into ~49 and
              // breaking every line mid-word. Sent only to the joining
              // socket — the others already have it.
              sendGeometry(client, msg.terminalId);
            } else {
              log.debug('ws', `Terminal subscribe ignored — ${msg.terminalId} not found`);
              if (client.readyState === 1) {
                try {
                  client.send(JSON.stringify({
                    type: WS_TYPES.TERMINAL_CLOSED,
                    terminalId: msg.terminalId,
                    reason: 'unavailable',
                  }));
                } catch { /* client disconnected */ }
              }
            }
          }
          break;
        case WS_TYPES.UPDATE_QUEUE_COUNT:
          if (typeof msg.sessionId === 'string' && typeof msg.count === 'number'
              && Number.isInteger(msg.count) && msg.count >= 0 && msg.count <= 10000) {
            // A remote device may only touch a session it can see (AASC-29).
            if (!client._isLocal && !canSeeSession(false, getSession(msg.sessionId))) break;
            const updated = updateQueueCount(msg.sessionId, msg.count);
            if (updated) {
              broadcast({ type: WS_TYPES.SESSION_UPDATE, session: updated });
            }
          }
          break;
        case WS_TYPES.REPLAY:
          // Client reconnected and wants events since a certain sequence number
          if (typeof msg.sinceSeq === 'number' && msg.sinceSeq >= 0) {
            const missed = getEventsSince(msg.sinceSeq);
            log.debug('ws', `Replaying ${missed.length} events since seq=${msg.sinceSeq}`);
            for (const evt of missed) {
              // The replay buffer holds every session's updates; a remote device
              // gets only those it could have received live (AASC-27).
              if (!mayReplay(client, evt.data)) continue;
              client.send(JSON.stringify(evt.data));
            }
          }
          break;
        default:
          break; // Silently ignore unknown types
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.debug('ws', `Invalid WS message: ${errMsg}`);
    }
  });

  client.on('close', () => {
    detachClient(client);
    log.info('ws', `Client disconnected (total: ${clients.size})`);
    // Stop heartbeat if no clients remain
    if (clients.size === 0) {
      stopHeartbeat();
    }
    broadcastPresence();
  });
  client.on('error', (err: Error) => {
    detachClient(client);
    log.error('ws', 'Client error:', err.message);
    broadcastPresence();
  });
}

/**
 * Tear down every reference to a departing socket.
 *
 * Terminal subscribers are a Set now, so — unlike the old single `wsClient`
 * reference, which the next subscriber simply overwrote — nothing evicts a dead
 * socket on its own. Skipping this leaks one entry per terminal per reconnect,
 * and every PTY chunk then pays a failed send for each corpse.
 */
function detachClient(client: WsClient): void {
  if (!clients.delete(client)) return; // already detached (close after error)
  removeClientFromAllTerminals(client);
  client._terminalIds.clear();
  if (client._clientId) presence.unregisterClient(client._clientId);
}

/**
 * Send one client the PTY's real geometry.
 *
 * Failure is deliberately silent: this is an optimization hint, not state the
 * client needs to function. A client that never receives it falls back to
 * fitting its own container, which is exactly the pre-existing behavior.
 */
function sendGeometry(client: WsClient, terminalId: string): void {
  const geom = getTerminalGeometry(terminalId);
  if (!geom || client.readyState !== 1) return;
  try {
    client.send(JSON.stringify({
      type: WS_TYPES.TERMINAL_GEOMETRY,
      terminalId,
      cols: geom.cols,
      rows: geom.rows,
    }));
  } catch { /* socket closed between the readyState check and the write */ }
}

/**
 * Tell every subscriber of this terminal its new geometry.
 *
 * Scoped to sockets that actually subscribed (`_terminalIds`) rather than
 * broadcast to all clients: a device with no terminal open has no use for it,
 * and terminal traffic is the highest-volume thing on this socket already.
 */
function broadcastGeometry(terminalId: string): void {
  for (const client of clients) {
    if (client._terminalIds.has(terminalId)) sendGeometry(client, terminalId);
  }
}

/** Tell every subscriber of this terminal that its output was cleared. */
function broadcastTerminalCleared(terminalId: string): void {
  const payload = JSON.stringify({ type: WS_TYPES.TERMINAL_CLEARED, terminalId });
  for (const client of clients) {
    if (!client._terminalIds.has(terminalId) || client.readyState !== 1) continue;
    try { client.send(payload); } catch { /* socket closed between the check and the write */ }
  }
}

/**
 * Which session owns this PTY.
 *
 * `sshManager.getTerminalSessionId` is the O(1) answer but is only populated by
 * `linkSession`, which runs on the workDir-matching path — sessions matched by
 * any other priority (and API-created ones) leave `term.sessionId` null. Relying
 * on it alone would silently disable the write gate for most terminals, which is
 * the worst possible failure here: the feature would look implemented and
 * arbitrate nothing. The session-store scan is the authoritative fallback
 * (`session.terminalId` survives CLI re-keying); it walks at most MAX_SESSIONS
 * entries and allocates nothing.
 */
function sessionIdForTerminal(terminalId: string): string | null {
  return getTerminalSessionId(terminalId) ?? getSessionIdByTerminalId(terminalId);
}

/**
 * May this client receive output from the PTY behind `terminalId`?
 *
 * Localhost always may. A remote client may only if the owning session is
 * opted into remote visibility. A terminal with NO resolvable session (an ops
 * shell, or a PTY whose first hook has not landed) is denied to remote clients:
 * an unattributable terminal cannot be shown to be safe, and for a visibility
 * gate the unknown case must fail closed. Localhost is unaffected, so the
 * desktop's ops shells keep working exactly as before.
 */
function canSubscribeToTerminal(client: WsClient, terminalId: string): boolean {
  if (client._isLocal) return true;
  // A paired phone never sees or types into an ops shell: it is a plain command
  // prompt, the one thing the phone profile exists to keep out of reach (AASC-28).
  // Typing goes through holdsControl, which asks this same question.
  if (client._deviceId && isOpsTerminal(terminalId)) return false;
  const sessionId = sessionIdForTerminal(terminalId);
  if (!sessionId) return false;
  return canSeeSession(false, getSession(sessionId));
}

/**
 * May this client write to the session behind `terminalId`?
 *
 * A terminal with no linked session (an ops shell, or a PTY whose first hook
 * has not landed) has no baton to arbitrate and is always writable — otherwise
 * a brand-new session would be unusable for the seconds before it is matched.
 *
 * Also emits a throttled `control_denied` so the UI can explain the silence
 * rather than looking broken.
 */
function holdsControl(client: WsClient, terminalId: string): boolean {
  // Remote devices (AASC-27): an anonymous socket never types, and the session
  // must still be shared NOW. Un-sharing doesn't wait for the device to
  // resubscribe; every write re-checks.
  if (!client._isLocal) {
    if (!client._clientId) return false;
    if (!canSubscribeToTerminal(client, terminalId)) return false;
  }
  // An unidentified LOCAL socket (an old cached client, or a non-browser
  // consumer on this machine) is not arbitrated: it writes freely, exactly as
  // before this feature. It must NOT reach noteControlActivity, which would
  // otherwise register '' as the holder and put a phantom device in the UI.
  if (!client._clientId) return true;

  const sessionId = sessionIdForTerminal(terminalId);
  if (!sessionId) return true;
  if (presence.noteControlActivity(sessionId, client._clientId)) return true;

  const now = Date.now();
  const lastAt = client._lastDenyAt.get(sessionId) ?? 0;
  if (now - lastAt >= CONTROL_DENY_NOTICE_MS && client.readyState === 1) {
    client._lastDenyAt.set(sessionId, now);
    const holder = presence.getController(sessionId);
    try {
      client.send(JSON.stringify({
        type: WS_TYPES.CONTROL_DENIED,
        sessionId,
        terminalId,
        by: holder?.label ?? null,
        byClientId: holder?.clientId ?? null,
      }));
    } catch { /* client vanished mid-send */ }
  }
  return false;
}

/** Tell a phone, at most every few seconds, why its keystrokes went nowhere. */
function noticeAgentNotRunning(client: WsClient, terminalId: string): void {
  const key = `agent:${terminalId}`;
  const now = Date.now();
  if (now - (client._lastDenyAt.get(key) ?? 0) < CONTROL_DENY_NOTICE_MS || client.readyState !== 1) return;
  client._lastDenyAt.set(key, now);
  try {
    client.send(JSON.stringify({ type: 'terminal_error', terminalId, error: 'A phone can type only while the agent is running' }));
  } catch { /* client vanished mid-send */ }
}

/**
 * The presence a client may see. Remote devices don't learn which hidden
 * sessions exist through the control-baton list (AASC-27).
 */
export function presenceFor(isLocal: boolean): ReturnType<typeof presence.presenceSnapshot> {
  const snapshot = presence.presenceSnapshot();
  if (isLocal) return snapshot;
  return {
    ...snapshot,
    controllers: snapshot.controllers.filter((c) => canSeeSession(false, getSession(c.sessionId))),
  };
}

/**
 * Close every live socket of a paired phone (AASC-15: revoke must end its
 * access within seconds, not when its session token next expires).
 */
export function disconnectDevice(deviceId: string): number {
  let closed = 0;
  for (const client of clients) {
    if (client._deviceId === deviceId) {
      // terminate(), not close(): ws keeps delivering incoming messages while a
      // close handshake is pending (up to its 30 s timeout), so a client that
      // ignores the close frame could keep typing after revocation.
      client.terminate();
      closed++;
    }
  }
  return closed;
}

/**
 * Send one device a message on every socket it has open (a desktop window and
 * its pop-outs share one device id). Returns how many sockets got it; 0 means
 * the device is not connected right now.
 */
export function sendToClientId<T extends { type: string }>(clientId: string, data: T): number {
  if (!clientId) return 0;
  const msg = JSON.stringify(data);
  let sent = 0;
  for (const client of clients) {
    if (client._clientId !== clientId || client.readyState !== 1) continue;
    try {
      client.send(msg);
      sent++;
    } catch { /* socket closed between the check and the write */ }
  }
  return sent;
}

/** Does this paired phone have an open socket right now? (The header chip's 📱 count, Oct 22 2026.) */
export function isPhoneDeviceOnline(deviceId: string): boolean {
  if (!deviceId) return false;
  for (const client of clients) {
    if (client._deviceId === deviceId && client.readyState === 1) return true;
  }
  return false;
}

/** Is this device a paired phone (its socket signed in with a phone's session, AASC-15)? */
export function isPairedPhoneClient(clientId: string): boolean {
  if (!clientId) return false;
  for (const client of clients) {
    if (client._clientId === clientId && client._deviceId) return true;
  }
  return false;
}

/**
 * Send this machine's sockets one payload and remote devices another, for a
 * message whose content depends on what a remote device may see (the room list,
 * AASC-20). A side given null gets nothing. Each payload is serialized once.
 */
export function broadcastByLocality<L extends { type: string }, R extends { type: string }>(
  local: L | null,
  remote: R | null,
): void {
  const localMsg = local ? JSON.stringify(local) : null;
  const remoteMsg = remote ? JSON.stringify(remote) : null;
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    const msg = client._isLocal ? localMsg : remoteMsg;
    if (!msg) continue;
    try { client.send(msg); } catch { /* client disconnected */ }
  }
}

type BroadcastListener = (data: { type: string; [key: string]: unknown }) => void;
const broadcastListeners = new Set<BroadcastListener>();

/**
 * Observe every outgoing broadcast (AASC-16: the push notifier watches
 * session_update). A listener that throws is logged and never breaks the
 * broadcast itself. Returns an unsubscribe function.
 */
export function onBroadcast(listener: BroadcastListener): () => void {
  broadcastListeners.add(listener);
  return () => { broadcastListeners.delete(listener); };
}

/** Push presence state to every client (device list, batons, writer). */
export function broadcastPresence(): void {
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(JSON.stringify({ type: WS_TYPES.PRESENCE_UPDATE, ...presenceFor(client._isLocal) }));
    } catch { /* client disconnected */ }
  }
}

/** May this client receive a buffered event on replay? Mirrors the live broadcast rule, using current visibility. */
function mayReplay(client: WsClient, data: unknown): boolean {
  if (client._isLocal) return true;
  if (!data || typeof data !== 'object') return true;
  const subject = broadcastSubject(data as { type: string; [key: string]: unknown });
  if (!subject) return true;
  const sessionId = (subject as { sessionId?: unknown }).sessionId;
  const live = typeof sessionId === 'string' ? getSession(sessionId) : null;
  // Both the session as it was and as it is now must be visible: an event from
  // while it was shared is not replayed after it was hidden.
  return canSeeSession(false, subject) && canSeeSession(false, live ?? UNRESOLVED_SUBJECT);
}

/**
 * A session stopped being shared: cut every remote device off it at once
 * (AASC-27). Their terminal subscriptions end, and the session card goes away.
 * Returns how many subscriptions were dropped.
 */
export function revokeRemoteSessionAccess(sessionId: string): number {
  let dropped = 0;
  for (const client of clients) {
    if (client._isLocal) continue;
    for (const terminalId of [...client._terminalIds]) {
      if (sessionIdForTerminal(terminalId) !== sessionId) continue;
      removeWsClient(terminalId, client);
      client._terminalIds.delete(terminalId);
      dropped++;
      if (client.readyState === 1) {
        try {
          client.send(JSON.stringify({ type: WS_TYPES.TERMINAL_CLOSED, terminalId, reason: 'hidden' }));
        } catch { /* client disconnected */ }
      }
    }
    if (client.readyState === 1) {
      try {
        client.send(JSON.stringify({ type: WS_TYPES.SESSION_REMOVED, sessionId }));
      } catch { /* client disconnected */ }
    }
  }
  return dropped;
}

/**
 * Check if a broadcast type is critical (must not be skipped under backpressure).
 * Session updates and snapshots are critical; hook_stats are not.
 */
function isCriticalBroadcast(data: { type: string }): boolean {
  return data.type !== WS_TYPES.HOOK_STATS;
}

/**
 * Broadcast a message to all connected WebSocket clients.
 * Throttles hook_stats to once per second; applies backpressure for non-critical messages.
 */
export function broadcast(data: { type: string; [key: string]: unknown }): void {
  // Throttle hook_stats broadcasts to once per second max
  if (data.type === WS_TYPES.HOOK_STATS) {
    const now = Date.now();
    if (now - lastHookStatsBroadcastAt < HOOK_STATS_THROTTLE_MS) {
      // Store for deferred send
      pendingHookStats = data;
      if (!hookStatsTimer) {
        hookStatsTimer = setTimeout(() => {
          hookStatsTimer = null;
          if (pendingHookStats) {
            const deferred = pendingHookStats as { type: string; [key: string]: unknown };
            pendingHookStats = null;
            lastHookStatsBroadcastAt = Date.now();
            broadcastToClients(deferred, false);
          }
        }, HOOK_STATS_THROTTLE_MS - (now - lastHookStatsBroadcastAt));
      }
      return;
    }
    lastHookStatsBroadcastAt = now;
  }

  const critical = isCriticalBroadcast(data);
  broadcastToClients(data, critical);
  for (const listener of broadcastListeners) {
    try {
      listener(data);
    } catch (err) {
      log.warn('ws', `Broadcast listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * What a broadcast is ABOUT, so remote clients can be skipped when that session is
 * hidden from them. Returns null for broadcasts that are not about one session
 * (presence, hook stats, teams), which are sent to everyone as before.
 *
 *  - `session_update` carries the session itself — read the flag off it.
 *  - `queue_update` carries only a `sessionId`, and what it carries is PROMPT TEXT.
 *    It is resolved through `getSession`, the lookup `requireVisibleSession` uses for
 *    the REST routes, so a re-keyed id resolves the same way on both paths. Without
 *    this the message had no `session` to inspect and went to every client: editing a
 *    hidden session's queue on the desktop pushed its prompts to every remote device.
 */
function broadcastSubject(data: { type: string; [key: string]: unknown }):
  { remoteVisible?: boolean | null } | null {
  // queue_sent carries the head of a sent prompt (AASC-20), chat_grew that a session is busy: the same rule.
  if (data.type === WS_TYPES.QUEUE_UPDATE || data.type === WS_TYPES.QUEUE_SENT || data.type === WS_TYPES.CHAT_GREW) {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    // A session that cannot be resolved (removed, archived, an id nobody has heard of, a
    // malformed message) is not visible to a remote client: for a visibility gate the
    // unknown case fails closed. The local desktop is unaffected — it sees everything.
    return getSession(sessionId) ?? UNRESOLVED_SUBJECT;
  }
  const session = data.session as { remoteVisible?: boolean | null } | undefined;
  return session && typeof session === 'object' ? session : null;
}

/** Stands in for a session that cannot be found: no `remoteVisible`, so hidden from remote clients. */
const UNRESOLVED_SUBJECT: { remoteVisible?: boolean | null } = Object.freeze({});

function broadcastToClients(data: { type: string; [key: string]: unknown }, critical: boolean): void {
  const msg = JSON.stringify(data);
  // Serialized once for the common case; a hidden-from-remote session simply
  // isn't sent, so no second payload is ever built.
  const subject = broadcastSubject(data);
  log.debug('ws', `Broadcasting ${data.type} to ${clients.size} clients`);
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    // A session update must not reach a device the session is hidden from —
    // otherwise the snapshot filter is pointless, since the very next status
    // change would re-introduce the card.
    if (subject && !canSeeSession(client._isLocal, subject)) continue;
    // Backpressure: skip non-critical updates if buffer is too large
    if (!critical && client.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      log.debug('ws', `Skipping ${data.type} for client (buffered=${client.bufferedAmount})`);
      continue;
    }
    client.send(msg);
  }
}
