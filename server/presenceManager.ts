/**
 * @module presenceManager
 *
 * Tracks which devices are pointed at this server, which one owns the one-shot
 * workspace restore, and which one holds the write "baton" for each session.
 *
 * ## Why this exists
 *
 * Every client that loads the dashboard used to run `useWorkspaceAutoLoad`,
 * whose first act is `POST /api/sessions/clear-all` — which kills every live
 * PTY and deletes every session — followed by re-creating them from the shared
 * snapshot. Opening the dashboard on a phone therefore destroyed and rebuilt
 * the workspace that the desktop app was actively using, producing duplicate
 * cards, dead terminals, and orphans dumped into "Ungrouped". The restore is a
 * global, destructive, once-per-server-boot operation being driven by per-client
 * code, so ownership has to live HERE, on the server, where there is exactly one
 * of it.
 *
 * ## The three rules that hold this together
 *
 * 1. **The restore claim is one-shot per SERVER PROCESS, not per device.** Even
 *    the device that already holds it is denied a second grant. A reload, a
 *    second tab, and a second device are all indistinguishable from "the
 *    workspace is already restored", and in every one of those cases the
 *    sessions are already alive — so restoring again can only destroy them.
 *    The claim resets when the server restarts, which is precisely when memory
 *    is empty and a restore IS wanted.
 *
 * 2. **A stale claim may only be re-granted when there is nothing to lose.**
 *    `isReclaimable` requires BOTH that the holder is disconnected AND that the
 *    server holds zero live sessions. Dropping the second condition would let a
 *    client whose restore crashed mid-flight come back and clear-all a
 *    workspace that other devices are using — the original bug, re-armed.
 *
 * 3. **An offline holder controls nothing.** `canControl` treats a disconnected
 *    holder as absent rather than releasing its entry, so closing the laptop
 *    hands its sessions to the phone with no timer, no grace period, and no
 *    cleanup pass that could race a reconnect. The entry is kept only so the UI
 *    can still say who had it last.
 *
 * Import-light and side-effect free at module scope so tests can drive it
 * directly; the only ambient state is the three Maps below, reset by
 * `_resetForTests`.
 */

import log from './logger.js';

/** How long a controller must be idle before another device may force a takeover. */
export const IDLE_TAKEOVER_MS = 60_000;

/**
 * How long a fresh restore claim is protected unconditionally.
 *
 * The claim arrives over HTTP but its holder's liveness is observed over the
 * WebSocket, and those two do not land at the same instant. Without this grace
 * window a claim made microseconds ago looks "stale" (holder not yet
 * registered) on a server with 0 live sessions — and 0 live sessions is exactly
 * the cold-start state in which two devices are most likely to be booting at
 * once. Both would be granted, both would restore, and the duplicate-session
 * bug returns through a race instead of through the front door.
 *
 * An explicit `releaseWorkspaceRestore` bypasses this entirely, so a genuinely
 * failed import still retries immediately.
 */
export const CLAIM_GRACE_MS = 60_000;

/** Upper bound on a device label. Mirrors `MAX_LABEL_LENGTH` in src/lib/deviceIdentity.ts. */
export const MAX_LABEL_LENGTH = 60;

export interface DevicePresence {
  clientId: string;
  label: string;
  /** Remote address of the most recent connection from this device. */
  address: string;
  /** True when the device connected over loopback (the Electron app or a local browser). */
  isLocal: boolean;
  /** Open WebSocket count for this device — two tabs of one browser is 2. */
  connections: number;
  connectedAt: number;
  lastSeenAt: number;
}

export interface ControlHolder {
  sessionId: string;
  clientId: string;
  label: string;
  since: number;
  lastActivityAt: number;
}

/** A control entry as sent to clients — carries whether the holder is still connected. */
export interface ControlHolderView extends ControlHolder {
  online: boolean;
}

export interface RestoreClaim {
  clientId: string;
  label: string;
  at: number;
}

export type ControlDenialReason = 'held-by-other' | 'not-idle-enough';

export interface ControlResult {
  ok: boolean;
  controller: ControlHolderView | null;
  reason?: ControlDenialReason;
  /** How long the current holder has been idle, when denied for `not-idle-enough`. */
  idleMs?: number;
  /** How much longer until a force-takeover would succeed. */
  retryInMs?: number;
}

const devices = new Map<string, DevicePresence>();
const controllers = new Map<string, ControlHolder>();
let restoreClaim: RestoreClaim | null = null;

/** Test seam: overridable clock so idle-takeover windows can be driven deterministically. */
let now: () => number = () => Date.now();

// ---------------------------------------------------------------------------
// Label hygiene
// ---------------------------------------------------------------------------

/**
 * A device label is attacker-controlled text (it arrives as a WS query param)
 * that is later logged and rendered. Strip C0/C1 control characters — a raw
 * newline would forge a second line in the server log — collapse whitespace,
 * and cap the length. Pure, so the hostile cases are unit-testable.
 */
export function sanitizeDeviceLabel(raw: unknown): string {
  if (typeof raw !== 'string') return 'Unknown device';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned || 'Unknown device';
}

/** True for loopback addresses — i.e. the Electron app or a browser on this machine. */
export function isLoopbackAddress(address: string): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

/**
 * Record a new WebSocket connection for a device. Called once per socket, so a
 * device with two tabs open registers twice and is only forgotten when both
 * close (`connections` refcount).
 */
export function registerClient(args: {
  clientId: string;
  label: string;
  address: string;
}): DevicePresence {
  const clientId = args.clientId;
  const label = sanitizeDeviceLabel(args.label);
  const at = now();
  const existing = devices.get(clientId);

  if (existing) {
    const updated: DevicePresence = {
      ...existing,
      // A rename or a move to a new network takes effect on the next connect.
      label,
      address: args.address,
      isLocal: isLoopbackAddress(args.address),
      connections: existing.connections + 1,
      lastSeenAt: at,
    };
    devices.set(clientId, updated);
    return updated;
  }

  const created: DevicePresence = {
    clientId,
    label,
    address: args.address,
    isLocal: isLoopbackAddress(args.address),
    connections: 1,
    connectedAt: at,
    lastSeenAt: at,
  };
  devices.set(clientId, created);
  log.info('presence', `Device connected: ${label} (${args.address})`);
  return created;
}

/** Drop one connection for a device; forgets the device when the last one closes. */
export function unregisterClient(clientId: string): void {
  const existing = devices.get(clientId);
  if (!existing) return;
  const connections = existing.connections - 1;
  if (connections > 0) {
    devices.set(clientId, { ...existing, connections, lastSeenAt: now() });
    return;
  }
  devices.delete(clientId);
  // Control entries are deliberately NOT cleared here — see rule 3 in the module
  // docblock. `canControl` already treats a disconnected holder as absent, and
  // keeping the row lets the UI show who had control last.
  log.info('presence', `Device disconnected: ${existing.label}`);
}

export function isClientConnected(clientId: string): boolean {
  const d = devices.get(clientId);
  return !!d && d.connections > 0;
}

export function touchDevice(clientId: string): void {
  const d = devices.get(clientId);
  if (d) devices.set(clientId, { ...d, lastSeenAt: now() });
}

export function listDevices(): DevicePresence[] {
  return [...devices.values()].sort((a, b) => a.connectedAt - b.connectedAt);
}

export function getDevice(clientId: string): DevicePresence | null {
  return devices.get(clientId) ?? null;
}

function labelFor(clientId: string, fallback: string): string {
  return devices.get(clientId)?.label ?? fallback;
}

// ---------------------------------------------------------------------------
// Workspace restore ownership
// ---------------------------------------------------------------------------

/**
 * A held claim may be re-granted only when all three hold: the grace window has
 * elapsed, the holder is gone, and the server has nothing left to protect.
 *
 * Every condition is load-bearing.
 *  - Without the grace window, two devices booting against a fresh server both
 *    get granted (the holder's WS has not registered yet) and both restore.
 *  - Without the liveness check, a crashed restore locks the workspace forever.
 *  - Without the zero-sessions check, a reconnecting client can clear-all a
 *    workspace other devices are actively using — the original bug.
 */
function isReclaimable(claim: RestoreClaim, liveSessionCount: number): boolean {
  if (now() - claim.at < CLAIM_GRACE_MS) return false;
  return !isClientConnected(claim.clientId) && liveSessionCount === 0;
}

export function claimWorkspaceRestore(args: {
  clientId: string;
  label: string;
  liveSessionCount: number;
}): { granted: boolean; reason?: 'already-restored'; by?: string; claimedAt?: number } {
  const label = sanitizeDeviceLabel(args.label);

  if (restoreClaim && !isReclaimable(restoreClaim, args.liveSessionCount)) {
    const by = labelFor(restoreClaim.clientId, restoreClaim.label);
    log.info(
      'presence',
      `Workspace restore denied for ${label} — already owned by ${by}` +
        `${restoreClaim.clientId === args.clientId ? ' (same device)' : ''}`,
    );
    return { granted: false, reason: 'already-restored', by, claimedAt: restoreClaim.at };
  }

  restoreClaim = { clientId: args.clientId, label, at: now() };
  log.info('presence', `Workspace restore claimed by ${label}`);
  return { granted: true, claimedAt: restoreClaim.at };
}

/**
 * Give the claim back — used when an import fails, so the next client (or a
 * reload) can retry instead of the workspace being permanently un-restorable.
 * Only the holder may release it.
 */
export function releaseWorkspaceRestore(clientId: string): boolean {
  if (!restoreClaim || restoreClaim.clientId !== clientId) return false;
  log.info('presence', `Workspace restore released by ${restoreClaim.label}`);
  restoreClaim = null;
  return true;
}

export function holdsRestoreClaim(clientId: string): boolean {
  return !!restoreClaim && restoreClaim.clientId === clientId;
}

export function getRestoreClaim(): RestoreClaim | null {
  return restoreClaim;
}

// ---------------------------------------------------------------------------
// Per-session control baton
// ---------------------------------------------------------------------------

function toView(holder: ControlHolder): ControlHolderView {
  return { ...holder, online: isClientConnected(holder.clientId) };
}

export function getController(sessionId: string): ControlHolderView | null {
  const holder = controllers.get(sessionId);
  return holder ? toView(holder) : null;
}

export function listControllers(): ControlHolderView[] {
  return [...controllers.values()].map(toView);
}

/**
 * May this client write to this session? True when the session is unclaimed,
 * already theirs, or held by a device that is no longer connected.
 */
export function canControl(sessionId: string, clientId: string): boolean {
  const holder = controllers.get(sessionId);
  if (!holder) return true;
  if (holder.clientId === clientId) return true;
  return !isClientConnected(holder.clientId);
}

/**
 * Take the baton. Succeeds when `canControl` allows it, or — with `force` —
 * when the current holder has been idle for at least `IDLE_TAKEOVER_MS`, so an
 * unattended desktop can never lock a user out of their own session from a phone.
 */
export function claimControl(
  sessionId: string,
  clientId: string,
  opts: { label?: string; force?: boolean } = {},
): ControlResult {
  const holder = controllers.get(sessionId);
  const at = now();

  if (holder && holder.clientId !== clientId && isClientConnected(holder.clientId)) {
    const idleMs = at - holder.lastActivityAt;
    if (!opts.force || idleMs < IDLE_TAKEOVER_MS) {
      return {
        ok: false,
        controller: toView(holder),
        reason: opts.force ? 'not-idle-enough' : 'held-by-other',
        idleMs,
        retryInMs: Math.max(0, IDLE_TAKEOVER_MS - idleMs),
      };
    }
    log.info('presence', `Control of ${sessionId} force-taken from ${holder.label} (idle ${Math.round(idleMs / 1000)}s)`);
  }

  const next: ControlHolder = {
    sessionId,
    clientId,
    label: labelFor(clientId, sanitizeDeviceLabel(opts.label ?? '')),
    // Preserve `since` across a refresh of an existing hold so the UI can show
    // a stable "controlling since" rather than resetting on every keystroke.
    since: holder && holder.clientId === clientId ? holder.since : at,
    lastActivityAt: at,
  };
  controllers.set(sessionId, next);
  return { ok: true, controller: toView(next) };
}

/**
 * Record that the controller acted, refreshing the idle-takeover window. Claims
 * the session implicitly when it is free, which is what makes "the device that
 * created a session controls it" fall out without an explicit claim call.
 *
 * Returns false when the write should be REJECTED (someone else holds it).
 */
export function noteControlActivity(sessionId: string, clientId: string): boolean {
  if (!canControl(sessionId, clientId)) return false;
  const holder = controllers.get(sessionId);
  const at = now();
  if (holder && holder.clientId === clientId) {
    controllers.set(sessionId, { ...holder, lastActivityAt: at });
    return true;
  }
  controllers.set(sessionId, {
    sessionId,
    clientId,
    label: labelFor(clientId, 'Unknown device'),
    since: at,
    lastActivityAt: at,
  });
  return true;
}

/** Hand the baton back. Only the holder may release. */
export function releaseControl(sessionId: string, clientId: string): boolean {
  const holder = controllers.get(sessionId);
  if (!holder || holder.clientId !== clientId) return false;
  controllers.delete(sessionId);
  return true;
}

/** Release every session this device holds — the "Release all" action. */
export function releaseAllControls(clientId: string): string[] {
  const released: string[] = [];
  for (const [sessionId, holder] of controllers) {
    if (holder.clientId === clientId) {
      controllers.delete(sessionId);
      released.push(sessionId);
    }
  }
  return released;
}

/**
 * Follow a session re-key (`replacesId`). Sessions are re-keyed from their
 * `term-*` placeholder to the CLI's real UUID moments after creation, so a
 * baton claimed at creation time would otherwise be stranded under an id that
 * no longer exists — silently making the creating device a spectator on its own
 * brand-new session.
 */
export function migrateControl(oldSessionId: string, newSessionId: string): void {
  const holder = controllers.get(oldSessionId);
  if (!holder) return;
  controllers.delete(oldSessionId);
  controllers.set(newSessionId, { ...holder, sessionId: newSessionId });
}

/** Forget a session's baton entirely (session killed / removed). */
export function dropControl(sessionId: string): void {
  controllers.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Workspace writer
// ---------------------------------------------------------------------------

/**
 * Which single device may persist the shared workspace snapshot.
 *
 * Auto-save is mounted on every client, and the snapshot it writes carries the
 * ROOM LAYOUT — which lives in each client's own localStorage, not on the
 * server. So a phone that has never seen the desktop's rooms will happily
 * overwrite them with its own empty set. (The existing "never save an empty
 * snapshot" guard does not catch this: the session list is fully populated from
 * the WS snapshot, so only the rooms are wrong.)
 *
 * A LOCAL device wins over a remote one, then the oldest connection wins. The
 * locality preference is the important half: the machine running the server is
 * the one whose room layout is authoritative, and it should keep that role even
 * if a phone has been connected for longer.
 *
 * Deliberately derived rather than claimed — there is no state to go stale, and
 * the role transfers by itself when the current writer disconnects.
 */
export function getWorkspaceWriter(): string | null {
  const connected = listDevices().filter((d) => d.connections > 0);
  if (connected.length === 0) return null;
  const local = connected.filter((d) => d.isLocal);
  return (local.length > 0 ? local : connected)[0].clientId;
}

/** True when this device may persist the workspace, including when nobody is registered. */
export function canWriteWorkspace(clientId: string): boolean {
  const writer = getWorkspaceWriter();
  // No registered devices at all → an HTTP-only caller (tests, curl, a client
  // whose socket has not landed yet) is not blocked from saving.
  return writer === null || writer === clientId;
}

/** Snapshot of everything a client needs to render presence. */
export function presenceSnapshot(): {
  devices: DevicePresence[];
  controllers: ControlHolderView[];
  restoreOwner: string | null;
  workspaceWriter: string | null;
} {
  return {
    devices: listDevices(),
    controllers: listControllers(),
    restoreOwner: restoreClaim?.clientId ?? null,
    workspaceWriter: getWorkspaceWriter(),
  };
}

/** Test-only reset + clock injection. */
export function _resetForTests(clock?: () => number): void {
  devices.clear();
  controllers.clear();
  restoreClaim = null;
  now = clock ?? (() => Date.now());
}
