// test/presenceManager.test.ts — multi-device presence, restore ownership, control baton.
//
// The suite exists because opening the dashboard on a second device used to
// destroy the first device's workspace: every client ran `useWorkspaceAutoLoad`,
// whose first act is `POST /api/sessions/clear-all` (kills every PTY, deletes
// every session) before rebuilding from the shared snapshot. Two clients doing
// that concurrently produced duplicate cards, dead terminals, and orphans in
// "Ungrouped".
//
// The three rules below are the ones that actually prevent recurrence; each has
// a named test, and each was a plausible-looking implementation that would have
// silently re-armed the bug:
//
//   1. The restore claim is one-shot per SERVER, so even the SAME device is
//      denied a second grant (a reload must not re-restore a live workspace).
//   2. A stale claim is re-grantable ONLY when zero sessions are live — the
//      liveness check alone would let a crashed client come back and clear-all
//      a workspace other devices are using.
//   3. A disconnected controller holds nothing, so closing a laptop hands its
//      sessions to the phone without any timer or cleanup pass.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IDLE_TAKEOVER_MS,
  CLAIM_GRACE_MS,
  MAX_LABEL_LENGTH,
  sanitizeDeviceLabel,
  isLoopbackAddress,
  registerClient,
  unregisterClient,
  isClientConnected,
  listDevices,
  claimWorkspaceRestore,
  releaseWorkspaceRestore,
  holdsRestoreClaim,
  canControl,
  claimControl,
  noteControlActivity,
  releaseControl,
  releaseAllControls,
  migrateControl,
  dropControl,
  getController,
  getWorkspaceWriter,
  canWriteWorkspace,
  presenceSnapshot,
  _resetForTests,
} from '../server/presenceManager.js';

/** Controllable clock so idle-takeover windows are deterministic. */
let clock = 1_000_000;
const advance = (ms: number): void => {
  clock += ms;
};

const DESKTOP = { clientId: 'desk-1', label: 'Mac · Desktop App', address: '127.0.0.1' };
const PHONE = { clientId: 'phone-1', label: 'iPhone · Safari', address: '192.168.1.42' };

beforeEach(() => {
  clock = 1_000_000;
  _resetForTests(() => clock);
});

describe('sanitizeDeviceLabel', () => {
  it('passes through a normal label', () => {
    expect(sanitizeDeviceLabel('iPhone · Safari')).toBe('iPhone · Safari');
  });

  it('strips control characters so a label cannot forge a second log line', () => {
    expect(sanitizeDeviceLabel('Mac\n[presence] FAKE LOG LINE')).toBe('Mac [presence] FAKE LOG LINE');
    expect(sanitizeDeviceLabel('a\x00b\x07c\x1Fd')).toBe('a b c d');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeDeviceLabel('   Mac    Desktop   ')).toBe('Mac Desktop');
  });

  it('caps length', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeDeviceLabel(long)).toHaveLength(MAX_LABEL_LENGTH);
  });

  it('falls back for empty / non-string input', () => {
    expect(sanitizeDeviceLabel('')).toBe('Unknown device');
    expect(sanitizeDeviceLabel('   ')).toBe('Unknown device');
    expect(sanitizeDeviceLabel(undefined)).toBe('Unknown device');
    expect(sanitizeDeviceLabel(42)).toBe('Unknown device');
    expect(sanitizeDeviceLabel(null)).toBe('Unknown device');
  });
});

describe('isLoopbackAddress', () => {
  it('recognises loopback in v4, v6, and v4-mapped-v6 forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
  });

  it('rejects LAN and public addresses', () => {
    expect(isLoopbackAddress('192.168.1.42')).toBe(false);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('203.0.113.9')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('device registry', () => {
  it('refcounts connections so two tabs of one browser stay one device', () => {
    registerClient(DESKTOP);
    registerClient(DESKTOP);
    expect(listDevices()).toHaveLength(1);
    expect(listDevices()[0].connections).toBe(2);

    unregisterClient(DESKTOP.clientId);
    expect(isClientConnected(DESKTOP.clientId)).toBe(true);

    unregisterClient(DESKTOP.clientId);
    expect(isClientConnected(DESKTOP.clientId)).toBe(false);
    expect(listDevices()).toHaveLength(0);
  });

  it('flags loopback devices as local', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    const [desk, phone] = listDevices();
    expect(desk.isLocal).toBe(true);
    expect(phone.isLocal).toBe(false);
  });

  it('sanitizes the label at registration', () => {
    registerClient({ clientId: 'x', label: 'Evil\nDevice', address: '127.0.0.1' });
    expect(listDevices()[0].label).toBe('Evil Device');
  });

  it('ignores unregister for an unknown device', () => {
    expect(() => unregisterClient('never-seen')).not.toThrow();
  });
});

describe('workspace restore claim', () => {
  it('grants the first claimant', () => {
    registerClient(DESKTOP);
    const res = claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    expect(res.granted).toBe(true);
    expect(holdsRestoreClaim(DESKTOP.clientId)).toBe(true);
  });

  it('denies a second, different device and names the owner', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });

    const res = claimWorkspaceRestore({ ...PHONE, liveSessionCount: 20 });
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('already-restored');
    expect(res.by).toBe('Mac · Desktop App');
  });

  // RULE 1 — the one-shot is per SERVER, not per device.
  it('denies the SAME device a second grant (reload / second tab)', () => {
    registerClient(DESKTOP);
    expect(claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 }).granted).toBe(true);

    const second = claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 20 });
    expect(second.granted).toBe(false);
    expect(second.reason).toBe('already-restored');
  });

  // RULE 2 — all three halves of isReclaimable are load-bearing.
  it('re-grants a stale claim only when NOTHING is live', () => {
    registerClient(DESKTOP);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    unregisterClient(DESKTOP.clientId); // holder is gone
    advance(CLAIM_GRACE_MS); // ...and has been for a while

    registerClient(PHONE);
    // Holder gone but sessions ARE live → still denied. This is the case that
    // would re-arm the original bug if the liveness check stood alone.
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 20 }).granted).toBe(false);

    // Holder gone AND nothing to destroy → safe to re-grant.
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 }).granted).toBe(true);
    expect(holdsRestoreClaim(PHONE.clientId)).toBe(true);
  });

  // The race that the HTTP-level test surfaced: the claim arrives over HTTP but
  // holder liveness is observed over the WebSocket, so a claim made moments ago
  // can look "stale" simply because its owner's socket has not registered yet —
  // on a cold server (0 sessions), which is exactly when two devices boot together.
  it('protects a brand-new claim even when the holder has no socket yet', () => {
    // Deliberately NOT registered — mirrors the window between the HTTP claim
    // and the WebSocket connect.
    expect(claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 }).granted).toBe(true);

    const racing = claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 });
    expect(racing.granted).toBe(false);
    expect(racing.by).toBe('Mac · Desktop App');
  });

  it('opens the claim again once the grace window lapses with the holder still absent', () => {
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    advance(CLAIM_GRACE_MS - 1);
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 }).granted).toBe(false);

    advance(1);
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 }).granted).toBe(true);
  });

  it('never opens the claim while sessions are live, however old it is', () => {
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    advance(CLAIM_GRACE_MS * 100);
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 20 }).granted).toBe(false);
  });

  it('keeps the claim held while the owner is still connected, even with 0 sessions', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 }).granted).toBe(false);
  });

  it('lets the holder release so a failed import can be retried', () => {
    registerClient(DESKTOP);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    expect(releaseWorkspaceRestore(DESKTOP.clientId)).toBe(true);

    registerClient(PHONE);
    expect(claimWorkspaceRestore({ ...PHONE, liveSessionCount: 0 }).granted).toBe(true);
  });

  it('refuses a release from a non-holder', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    expect(releaseWorkspaceRestore(PHONE.clientId)).toBe(false);
    expect(holdsRestoreClaim(DESKTOP.clientId)).toBe(true);
  });
});

describe('control baton', () => {
  beforeEach(() => {
    registerClient(DESKTOP);
    registerClient(PHONE);
  });

  it('lets anyone control an unclaimed session', () => {
    expect(canControl('s1', DESKTOP.clientId)).toBe(true);
    expect(canControl('s1', PHONE.clientId)).toBe(true);
  });

  it('locks others out once claimed', () => {
    expect(claimControl('s1', DESKTOP.clientId).ok).toBe(true);
    expect(canControl('s1', DESKTOP.clientId)).toBe(true);
    expect(canControl('s1', PHONE.clientId)).toBe(false);
  });

  it('reports the holder on denial', () => {
    claimControl('s1', DESKTOP.clientId);
    const res = claimControl('s1', PHONE.clientId);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('held-by-other');
    expect(res.controller?.label).toBe('Mac · Desktop App');
  });

  // RULE 3 — an offline holder holds nothing.
  it('frees the session when the holder disconnects', () => {
    claimControl('s1', DESKTOP.clientId);
    expect(canControl('s1', PHONE.clientId)).toBe(false);

    unregisterClient(DESKTOP.clientId);
    expect(canControl('s1', PHONE.clientId)).toBe(true);
    expect(claimControl('s1', PHONE.clientId).ok).toBe(true);
  });

  it('still names the offline holder for the UI', () => {
    claimControl('s1', DESKTOP.clientId);
    unregisterClient(DESKTOP.clientId);
    const view = getController('s1');
    expect(view?.label).toBe('Mac · Desktop App');
    expect(view?.online).toBe(false);
  });

  it('refuses a force-takeover before the idle window elapses', () => {
    claimControl('s1', DESKTOP.clientId);
    advance(IDLE_TAKEOVER_MS - 1);

    const res = claimControl('s1', PHONE.clientId, { force: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-idle-enough');
    expect(res.retryInMs).toBe(1);
  });

  it('allows a force-takeover once the holder has been idle long enough', () => {
    claimControl('s1', DESKTOP.clientId);
    advance(IDLE_TAKEOVER_MS);

    const res = claimControl('s1', PHONE.clientId, { force: true });
    expect(res.ok).toBe(true);
    expect(res.controller?.clientId).toBe(PHONE.clientId);
    expect(canControl('s1', DESKTOP.clientId)).toBe(false);
  });

  it('activity refreshes the idle window, so an active holder is never taken from', () => {
    claimControl('s1', DESKTOP.clientId);
    advance(IDLE_TAKEOVER_MS - 1);
    expect(noteControlActivity('s1', DESKTOP.clientId)).toBe(true);

    advance(IDLE_TAKEOVER_MS - 1);
    expect(claimControl('s1', PHONE.clientId, { force: true }).ok).toBe(false);
  });

  it('noteControlActivity rejects a write from a non-holder', () => {
    claimControl('s1', DESKTOP.clientId);
    expect(noteControlActivity('s1', PHONE.clientId)).toBe(false);
  });

  it('noteControlActivity implicitly claims a free session (creator owns it)', () => {
    expect(noteControlActivity('s1', DESKTOP.clientId)).toBe(true);
    expect(canControl('s1', PHONE.clientId)).toBe(false);
  });

  it('preserves `since` across a re-claim by the same holder', () => {
    claimControl('s1', DESKTOP.clientId);
    const since = getController('s1')!.since;
    advance(5000);
    claimControl('s1', DESKTOP.clientId);
    expect(getController('s1')!.since).toBe(since);
    expect(getController('s1')!.lastActivityAt).toBe(since + 5000);
  });

  it('only the holder may release', () => {
    claimControl('s1', DESKTOP.clientId);
    expect(releaseControl('s1', PHONE.clientId)).toBe(false);
    expect(releaseControl('s1', DESKTOP.clientId)).toBe(true);
    expect(getController('s1')).toBeNull();
  });

  it('releaseAllControls frees only that device’s sessions', () => {
    claimControl('s1', DESKTOP.clientId);
    claimControl('s2', DESKTOP.clientId);
    claimControl('s3', PHONE.clientId);

    expect(releaseAllControls(DESKTOP.clientId).sort()).toEqual(['s1', 's2']);
    expect(getController('s1')).toBeNull();
    expect(getController('s3')?.clientId).toBe(PHONE.clientId);
  });

  // A session is re-keyed from its term-* placeholder to the CLI's real UUID
  // moments after creation. Without this, the creating device silently becomes
  // a spectator on the session it just launched.
  it('migrateControl follows a session re-key', () => {
    claimControl('term-123', DESKTOP.clientId);
    migrateControl('term-123', 'uuid-abc');

    expect(getController('term-123')).toBeNull();
    expect(getController('uuid-abc')?.clientId).toBe(DESKTOP.clientId);
    expect(getController('uuid-abc')?.sessionId).toBe('uuid-abc');
    expect(canControl('uuid-abc', PHONE.clientId)).toBe(false);
  });

  it('migrateControl is a no-op for an uncontrolled session', () => {
    expect(() => migrateControl('nope', 'also-nope')).not.toThrow();
    expect(getController('also-nope')).toBeNull();
  });

  it('dropControl forgets a killed session', () => {
    claimControl('s1', DESKTOP.clientId);
    dropControl('s1');
    expect(getController('s1')).toBeNull();
    expect(canControl('s1', PHONE.clientId)).toBe(true);
  });
});

// The snapshot carries the ROOM LAYOUT, which lives in each client's own
// localStorage — so a phone that has never seen the desktop's rooms would
// overwrite them with its own empty set. The "never save an empty snapshot"
// guard does not catch that: the session list is fully populated from the WS
// snapshot, and only the rooms are wrong.
describe('workspace writer', () => {
  it('prefers a LOCAL device over a remote one that connected first', () => {
    registerClient(PHONE); // remote, connected first
    advance(1000);
    registerClient(DESKTOP); // local, connected later

    expect(getWorkspaceWriter()).toBe(DESKTOP.clientId);
    expect(canWriteWorkspace(DESKTOP.clientId)).toBe(true);
    expect(canWriteWorkspace(PHONE.clientId)).toBe(false);
  });

  it('falls back to the oldest remote device when no local device is connected', () => {
    registerClient(PHONE);
    advance(1000);
    registerClient({ clientId: 'tablet-1', label: 'iPad · Safari', address: '192.168.1.77' });

    expect(getWorkspaceWriter()).toBe(PHONE.clientId);
  });

  it('transfers the role by itself when the writer disconnects', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    expect(getWorkspaceWriter()).toBe(DESKTOP.clientId);

    unregisterClient(DESKTOP.clientId);
    expect(getWorkspaceWriter()).toBe(PHONE.clientId);
    expect(canWriteWorkspace(PHONE.clientId)).toBe(true);
  });

  it('does not block an HTTP-only caller when no device is registered', () => {
    expect(getWorkspaceWriter()).toBeNull();
    expect(canWriteWorkspace('anyone')).toBe(true);
  });
});

describe('presenceSnapshot', () => {
  it('carries devices, controllers, the restore owner, and the writer', () => {
    registerClient(DESKTOP);
    registerClient(PHONE);
    claimWorkspaceRestore({ ...DESKTOP, liveSessionCount: 0 });
    claimControl('s1', DESKTOP.clientId);

    const snap = presenceSnapshot();
    expect(snap.devices.map((d) => d.clientId)).toEqual([DESKTOP.clientId, PHONE.clientId]);
    expect(snap.controllers).toHaveLength(1);
    expect(snap.controllers[0].online).toBe(true);
    expect(snap.restoreOwner).toBe(DESKTOP.clientId);
    expect(snap.workspaceWriter).toBe(DESKTOP.clientId);
  });
});
