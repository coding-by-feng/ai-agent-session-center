import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useQueueStore,
  automationConfigFromRow,
  DEFAULT_AUTOMATION,
  type QueueItem,
} from './queueStore';
import { getClientId, getWindowOriginId } from '@/lib/deviceIdentity';
import { clearLocalStorage } from '../__tests__/setup';
import type { DbQueueAutomation } from '@/lib/db';

function makeRow(overrides: Partial<DbQueueAutomation> = {}): DbQueueAutomation {
  return {
    sessionId: 's1',
    paused: 0,
    idleGuard: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeItem(id: number, sessionId: string, position: number): QueueItem {
  return {
    id,
    sessionId,
    text: `Prompt #${id}`,
    position,
    createdAt: Date.now(),
  };
}

describe('queueStore', () => {
  beforeEach(() => {
    useQueueStore.setState({ queues: new Map() });
  });

  describe('add', () => {
    it('adds an item to a session queue', () => {
      const item = makeItem(1, 's1', 0);
      useQueueStore.getState().add('s1', item);
      const items = useQueueStore.getState().queues.get('s1');
      expect(items).toHaveLength(1);
      expect(items![0].id).toBe(1);
    });

    it('appends to existing queue', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().add('s1', makeItem(2, 's1', 1));
      const items = useQueueStore.getState().queues.get('s1');
      expect(items).toHaveLength(2);
    });

    it('creates separate queues per session', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().add('s2', makeItem(2, 's2', 0));
      expect(useQueueStore.getState().queues.get('s1')).toHaveLength(1);
      expect(useQueueStore.getState().queues.get('s2')).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('removes an item by id', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().add('s1', makeItem(2, 's1', 1));
      useQueueStore.getState().remove('s1', 1);
      const items = useQueueStore.getState().queues.get('s1');
      expect(items).toHaveLength(1);
      expect(items![0].id).toBe(2);
    });

    it('handles removing from empty queue', () => {
      useQueueStore.getState().remove('s1', 999);
      const items = useQueueStore.getState().queues.get('s1');
      expect(items).toEqual([]);
    });
  });

  describe('reorder', () => {
    it('reorders items and updates positions', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().add('s1', makeItem(2, 's1', 1));
      useQueueStore.getState().add('s1', makeItem(3, 's1', 2));

      // Reverse order
      useQueueStore.getState().reorder('s1', [3, 2, 1]);
      const items = useQueueStore.getState().queues.get('s1')!;
      expect(items[0].id).toBe(3);
      expect(items[0].position).toBe(0);
      expect(items[1].id).toBe(2);
      expect(items[1].position).toBe(1);
      expect(items[2].id).toBe(1);
      expect(items[2].position).toBe(2);
    });

    it('filters out non-existent ids', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().reorder('s1', [1, 999]);
      const items = useQueueStore.getState().queues.get('s1')!;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(1);
    });
  });

  describe('moveToSession', () => {
    it('moves items from one session queue to another', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().add('s1', makeItem(2, 's1', 1));
      useQueueStore.getState().add('s1', makeItem(3, 's1', 2));

      useQueueStore.getState().moveToSession([1, 3], 's1', 's2');

      const from = useQueueStore.getState().queues.get('s1')!;
      const to = useQueueStore.getState().queues.get('s2')!;

      expect(from).toHaveLength(1);
      expect(from[0].id).toBe(2);

      expect(to).toHaveLength(2);
      expect(to[0].sessionId).toBe('s2');
      expect(to[1].sessionId).toBe('s2');
    });

    it('assigns sequential positions in target queue', () => {
      useQueueStore.getState().add('s2', makeItem(10, 's2', 0));
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));

      useQueueStore.getState().moveToSession([1], 's1', 's2');

      const to = useQueueStore.getState().queues.get('s2')!;
      expect(to).toHaveLength(2);
      expect(to[0].position).toBe(0); // existing item
      expect(to[1].position).toBe(1); // moved item
    });

    it('handles moving to empty queue', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      useQueueStore.getState().moveToSession([1], 's1', 's2');

      const to = useQueueStore.getState().queues.get('s2')!;
      expect(to).toHaveLength(1);
      expect(to[0].position).toBe(0);
    });
  });

  describe('setQueue', () => {
    it('replaces the queue for a session', () => {
      useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
      const newItems = [makeItem(10, 's1', 0), makeItem(11, 's1', 1)];
      useQueueStore.getState().setQueue('s1', newItems);
      const items = useQueueStore.getState().queues.get('s1')!;
      expect(items).toHaveLength(2);
      expect(items[0].id).toBe(10);
    });
  });

  describe('migrateSession', () => {
    it('moves queue items from old sessionId to new sessionId', () => {
      useQueueStore.getState().add('old-id', makeItem(1, 'old-id', 0));
      useQueueStore.getState().add('old-id', makeItem(2, 'old-id', 1));

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      expect(useQueueStore.getState().queues.has('old-id')).toBe(false);
      const items = useQueueStore.getState().queues.get('new-id')!;
      expect(items).toHaveLength(2);
      expect(items[0].sessionId).toBe('new-id');
      expect(items[1].sessionId).toBe('new-id');
      expect(items[0].id).toBe(1);
      expect(items[1].id).toBe(2);
    });

    it('is a no-op when old session has no queue', () => {
      useQueueStore.getState().add('other', makeItem(1, 'other', 0));

      const prevState = useQueueStore.getState();
      useQueueStore.getState().migrateSession('nonexistent', 'new-id');

      // State reference unchanged (returned `state` without modification)
      expect(useQueueStore.getState().queues).toBe(prevState.queues);
    });

    it('preserves text and position of migrated items', () => {
      const item = makeItem(5, 'old-id', 3);
      item.text = 'Custom prompt text';
      useQueueStore.getState().add('old-id', item);

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      const items = useQueueStore.getState().queues.get('new-id')!;
      expect(items[0].text).toBe('Custom prompt text');
      expect(items[0].position).toBe(3);
    });

    it('preserves loop scheduling fields so a resumed loop keeps looping', () => {
      // A `claude --resume` re-keys the session; the loop must survive the
      // re-key with its automation intact (it should re-fire, not vanish).
      const loop: QueueItem = {
        id: 9,
        sessionId: 'old-id',
        text: 'run tests',
        position: 0,
        createdAt: 100,
        type: 'loop',
        intervalMs: 300_000,
        nextFireAt: 999_999,
        totalFires: 7,
      };
      useQueueStore.getState().add('old-id', loop);

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      const items = useQueueStore.getState().queues.get('new-id')!;
      expect(items[0].type).toBe('loop');
      expect(items[0].intervalMs).toBe(300_000);
      expect(items[0].nextFireAt).toBe(999_999);
      expect(items[0].totalFires).toBe(7);
      expect(items[0].sessionId).toBe('new-id');
    });

    it('carries the per-session automation (paused / auto-send) across the re-key', () => {
      // A session the user explicitly PAUSED must come back paused after a
      // `claude --resume` re-keys it — otherwise the paused loop silently
      // re-arms and fires one interval after the restore.
      useQueueStore.setState({ automation: new Map() });
      useQueueStore.getState().add('old-id', makeItem(1, 'old-id', 0));
      useQueueStore.getState().setPaused('old-id', true);
      useQueueStore.getState().setAutoSend('old-id', false);

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      expect(useQueueStore.getState().automation.has('old-id')).toBe(false);
      const cfg = useQueueStore.getState().getAutomation('new-id');
      expect(cfg.paused).toBe(true);
      expect(cfg.autoSend).toBe(false);
    });

    it('does not clobber an automation config the new id already has', () => {
      useQueueStore.setState({ automation: new Map() });
      useQueueStore.getState().add('old-id', makeItem(1, 'old-id', 0));
      useQueueStore.getState().setPaused('old-id', true);
      // The new id was already configured (e.g. an explicit restore set it).
      useQueueStore.getState().setPaused('new-id', false);

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      // new-id keeps its own config, not old-id's.
      expect(useQueueStore.getState().getAutomation('new-id').paused).toBe(false);
      expect(useQueueStore.getState().automation.has('old-id')).toBe(false);
    });

    it('migrates automation even when the session has no queue items', () => {
      useQueueStore.setState({ automation: new Map(), queues: new Map() });
      useQueueStore.getState().setPaused('old-id', true);

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      expect(useQueueStore.getState().getAutomation('new-id').paused).toBe(true);
      expect(useQueueStore.getState().automation.has('old-id')).toBe(false);
    });

    it('carries an in-progress compose draft across the re-key', () => {
      // A half-typed prompt the user was mid-composing when `claude --resume`
      // landed must not vanish — orphaned under an id nothing references any
      // more once the component's next render reads the NEW session id.
      useQueueStore.setState({ composeDrafts: new Map() });
      useQueueStore.getState().setComposeDraft('old-id', { text: 'unfinished prompt', type: 'loop' });

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      expect(useQueueStore.getState().composeDrafts.has('old-id')).toBe(false);
      const draft = useQueueStore.getState().getComposeDraft('new-id');
      expect(draft.text).toBe('unfinished prompt');
      expect(draft.type).toBe('loop');
    });

    it('does not clobber a compose draft the new id already has', () => {
      useQueueStore.setState({ composeDrafts: new Map() });
      useQueueStore.getState().setComposeDraft('old-id', { text: 'from old session' });
      useQueueStore.getState().setComposeDraft('new-id', { text: 'already typing here' });

      useQueueStore.getState().migrateSession('old-id', 'new-id');

      expect(useQueueStore.getState().getComposeDraft('new-id').text).toBe('already typing here');
      expect(useQueueStore.getState().composeDrafts.has('old-id')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-send / auto-enter are PER-SESSION (they live in each session's
// QueueAutomationConfig). Toggling one session must never affect another, and
// both the QueueTab toggle and the scheduler read the same per-session value
// so the visible toggle and the actual firing can never disagree.
// ---------------------------------------------------------------------------
describe('queueStore — per-session auto-send / auto-enter', () => {
  beforeEach(() => {
    clearLocalStorage();
    useQueueStore.setState({ automation: new Map() });
  });

  it('defaults to ON for a session with no automation row', () => {
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoSend).toBe(true);
    expect(cfg.autoEnter).toBe(true);
  });

  it('setAutoSend updates only the targeted session', () => {
    useQueueStore.getState().setAutoSend('s1', false);
    expect(useQueueStore.getState().getAutomation('s1').autoSend).toBe(false);
    // A different session is unaffected — still the default ON.
    expect(useQueueStore.getState().getAutomation('s2').autoSend).toBe(true);

    useQueueStore.getState().setAutoSend('s1', true);
    expect(useQueueStore.getState().getAutomation('s1').autoSend).toBe(true);
  });

  it('setAutoEnter updates only the targeted session', () => {
    useQueueStore.getState().setAutoEnter('s1', false);
    expect(useQueueStore.getState().getAutomation('s1').autoEnter).toBe(false);
    expect(useQueueStore.getState().getAutomation('s2').autoEnter).toBe(true);
  });

  it('does not clobber sibling automation flags when toggling', () => {
    useQueueStore.getState().setPaused('s1', true);
    useQueueStore.getState().setAutoSend('s1', false);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.paused).toBe(true);
    expect(cfg.autoSend).toBe(false);
    expect(cfg.idleGuard).toBe(true);
  });

  // autoSend and autoEnter are deliberately independent (Aug 2026) — see
  // setAutoEnter's comment in queueStore.ts. An earlier version force-enabled
  // autoSend whenever autoEnter turned on, to avoid "Auto-Enter ON, Auto-send
  // OFF" reading as a silent no-op; that traded away a real combo (manual-fire
  // via ⚡ NOW, but a real Enter keystroke once fired) and — worse — the
  // restore path re-imposed it on every reload even after the user explicitly
  // turned Auto-send back off. These four tests together prove BOTH toggles
  // move independently in BOTH directions, and that a value survives a
  // reload unchanged (the specific bug the old coupling reintroduced).

  it('enabling auto-enter does NOT enable auto-send', () => {
    useQueueStore.getState().setAutoSend('s1', false);
    expect(useQueueStore.getState().getAutomation('s1').autoSend).toBe(false);

    useQueueStore.getState().setAutoEnter('s1', true);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoEnter).toBe(true);
    expect(cfg.autoSend).toBe(false); // must stay OFF — the user's own choice
  });

  it('disabling auto-enter does NOT disable auto-send', () => {
    useQueueStore.getState().setAutoSend('s1', true);
    useQueueStore.getState().setAutoEnter('s1', false);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoEnter).toBe(false);
    expect(cfg.autoSend).toBe(true);
  });

  it('enabling auto-send does NOT enable auto-enter', () => {
    useQueueStore.getState().setAutoEnter('s1', false);
    useQueueStore.getState().setAutoSend('s1', true);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoSend).toBe(true);
    expect(cfg.autoEnter).toBe(false);
  });

  it('disabling auto-send does NOT disable auto-enter', () => {
    useQueueStore.getState().setAutoEnter('s1', true);
    useQueueStore.getState().setAutoSend('s1', false);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoSend).toBe(false);
    expect(cfg.autoEnter).toBe(true);
  });
});

describe('automationConfigFromRow — the restore path (loadFromDb)', () => {
  // IndexedDB isn't available in this test environment, so loadFromDb itself
  // has no practical unit-test path — these exercise the pure row-mapping
  // function it delegates to, which is where the actual restore-time bug
  // (and its fix) lived.

  it('preserves an explicit autoEnter:true, autoSend:false row unchanged', () => {
    // The exact case the old self-heal used to silently "fix": a user turns
    // Auto-send off while Auto-Enter is on, reloads, and the old code forced
    // autoSend back to true — reverting their choice with nothing logged.
    const row = makeRow({ autoEnter: 1, autoSend: 0 });
    const cfg = automationConfigFromRow(row);
    expect(cfg.autoEnter).toBe(true);
    expect(cfg.autoSend).toBe(false); // must NOT be healed back to true
  });

  it('preserves an explicit autoEnter:false, autoSend:true row unchanged', () => {
    const row = makeRow({ autoEnter: 0, autoSend: 1 });
    const cfg = automationConfigFromRow(row);
    expect(cfg.autoEnter).toBe(false);
    expect(cfg.autoSend).toBe(true);
  });

  it('defaults BOTH fields to true only when the column is absent (legacy row)', () => {
    // A row saved before auto-send/auto-enter existed as separate columns —
    // `undefined`, not `0`. Must default ON to preserve the prior behavior.
    const row = makeRow({ autoEnter: undefined, autoSend: undefined });
    const cfg = automationConfigFromRow(row);
    expect(cfg.autoEnter).toBe(true);
    expect(cfg.autoSend).toBe(true);
  });

  it('defaults only the absent column when just one is legacy-missing', () => {
    // A row from between the two columns' introduction — autoEnter recorded,
    // autoSend not yet a field. autoEnter's explicit 0 must survive; autoSend
    // (truly absent) defaults to true.
    const row = makeRow({ autoEnter: 0, autoSend: undefined });
    const cfg = automationConfigFromRow(row);
    expect(cfg.autoEnter).toBe(false);
    expect(cfg.autoSend).toBe(true);
  });

  it('does not touch idleGuard/skipWhenPrompting/autoResume based on autoEnter', () => {
    // Guards against a future regression re-coupling autoEnter to some OTHER
    // field instead of autoSend.
    const row = makeRow({ autoEnter: 1, idleGuard: 0, skipWhenPrompting: 0, autoResume: 0 });
    const cfg = automationConfigFromRow(row);
    expect(cfg.autoEnter).toBe(true);
    expect(cfg.idleGuard).toBe(false);
    expect(cfg.skipWhenPrompting).toBe(false);
    expect(cfg.autoResume).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The compose draft is PER-SESSION for the same reason automation is:
// `QueueTab` mounts twice simultaneously for one session (the DetailPanel
// strip + the dedicated Queue tab), and neither render call site keys the
// component by sessionId — so switching sessions updates props on the SAME
// instance rather than unmounting it. A plain useState draft therefore
// survives a session switch and leaks into whatever session you switched TO.
// These tests cover the store side of the fix; the component-level render
// check (proving a REAL session-prop change doesn't leak) lives in
// QueueTab.test.tsx.
// ---------------------------------------------------------------------------
describe('queueStore — per-session compose draft', () => {
  beforeEach(() => {
    useQueueStore.setState({ composeDrafts: new Map() });
  });

  it('defaults to empty for a session with no draft yet', () => {
    const draft = useQueueStore.getState().getComposeDraft('s1');
    expect(draft.text).toBe('');
    expect(draft.images).toEqual([]);
    expect(draft.type).toBe('once');
  });

  it('setComposeDraft on one session never appears on another — the reported bug', () => {
    useQueueStore.getState().setComposeDraft('session-a', { text: 'add: Refero (https://refero.design)' });

    // Session B has never been touched — must read the untouched default,
    // NOT session A's draft. This is the exact leak the user reported.
    const draftB = useQueueStore.getState().getComposeDraft('session-b');
    expect(draftB.text).toBe('');

    const draftA = useQueueStore.getState().getComposeDraft('session-a');
    expect(draftA.text).toBe('add: Refero (https://refero.design)');
  });

  it('patches merge onto the existing draft rather than replacing it', () => {
    useQueueStore.getState().setComposeDraft('s1', { text: 'hello' });
    useQueueStore.getState().setComposeDraft('s1', { type: 'loop' });

    const draft = useQueueStore.getState().getComposeDraft('s1');
    expect(draft.text).toBe('hello'); // must survive the second, unrelated patch
    expect(draft.type).toBe('loop');
  });

  it('a session\'s draft survives switching away and back (not just isolation)', () => {
    // Stronger than isolation alone: a `key={sessionId}` remount would ALSO
    // stop the leak, but would wipe session A's own draft the moment you
    // glance at session B. The store-backed draft must not have that cost.
    useQueueStore.getState().setComposeDraft('session-a', { text: 'mid-thought' });
    useQueueStore.getState().getComposeDraft('session-b'); // "switch to" B, read only
    const draftA = useQueueStore.getState().getComposeDraft('session-a');
    expect(draftA.text).toBe('mid-thought');
  });

  it('resetting one field (post-ADD) does not clear unrelated fields', () => {
    // Mirrors the actual post-ADD patch in QueueTab: text/images/runAt reset,
    // type/interval deliberately persist for batch-adding loop/schedule items.
    useQueueStore.getState().setComposeDraft('s1', {
      text: 'first item', type: 'loop', intervalValue: 30, intervalUnit: 'sec',
    });
    useQueueStore.getState().setComposeDraft('s1', { text: '', images: [], runAt: '' });

    const draft = useQueueStore.getState().getComposeDraft('s1');
    expect(draft.text).toBe('');
    expect(draft.type).toBe('loop'); // NOT reset
    expect(draft.intervalValue).toBe(30); // NOT reset
    expect(draft.intervalUnit).toBe('sec'); // NOT reset
  });

  it('multiple sessions maintain fully independent drafts concurrently', () => {
    useQueueStore.getState().setComposeDraft('s1', { text: 'draft one', type: 'once' });
    useQueueStore.getState().setComposeDraft('s2', { text: 'draft two', type: 'loop' });
    useQueueStore.getState().setComposeDraft('s3', { text: 'draft three', type: 'schedule' });

    expect(useQueueStore.getState().getComposeDraft('s1').text).toBe('draft one');
    expect(useQueueStore.getState().getComposeDraft('s2').text).toBe('draft two');
    expect(useQueueStore.getState().getComposeDraft('s3').text).toBe('draft three');
    expect(useQueueStore.getState().getComposeDraft('s1').type).toBe('once');
    expect(useQueueStore.getState().getComposeDraft('s2').type).toBe('loop');
    expect(useQueueStore.getState().getComposeDraft('s3').type).toBe('schedule');
  });
});

// ---------------------------------------------------------------------------
// Server sync — the fix for "the phone and the desktop show different queues".
// The queue used to live only in each browser's IndexedDB, so every device
// had a private copy that never synced. These cover the two rules that make
// the shared version safe: the echo guard (or two devices ping-pong forever)
// and the seeding rule (or the first launch of the new build appears to wipe
// the user's queue).
// ---------------------------------------------------------------------------
describe('queueStore — server sync', () => {
  beforeEach(() => {
    clearLocalStorage();
    useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
  });

  it('applies a queue pushed by another device', () => {
    useQueueStore.getState().applyRemoteQueue(
      's1',
      [makeItem(1, 's1', 0), makeItem(2, 's1', 1)],
      null,
      'some-other-device',
    );
    expect(useQueueStore.getState().queues.get('s1')).toHaveLength(2);
  });

  it('IGNORES our own echo — the ping-pong guard', () => {
    // The server broadcasts every write to all devices including the sender.
    // Applying our own echo would mark the store dirty, push it again, and
    // loop indefinitely between two devices.
    const myId = getWindowOriginId();
    useQueueStore.getState().applyRemoteQueue('s1', [makeItem(1, 's1', 0)], null, myId);
    expect(useQueueStore.getState().queues.has('s1')).toBe(false);
  });

  it('APPLIES an update from another window of this same device', () => {
    // Two windows of one app install share one device id (localStorage). A
    // guard keyed on the device id would drop the sibling window's update as
    // "my own echo", leaving this window — and the scheduler that fires from
    // its store — blind to items added in the float window.
    //
    // The id a sibling really sends (`<device>:<its nonce>`) differs from ours
    // under EITHER guard, so on its own this proves little; the case that tells
    // the two guards apart is the bare device id — what a window of an older
    // build stamps — which a device-keyed guard would drop and ours must apply.
    // queueStore.sync.test.ts runs the real thing: two store instances and a
    // fake server between them.
    useQueueStore.getState().applyRemoteQueue(
      's1',
      [makeItem(1, 's1', 0)],
      null,
      `${getClientId()}:another-window`,
    );
    expect(useQueueStore.getState().queues.get('s1')).toHaveLength(1);

    useQueueStore.getState().applyRemoteQueue(
      's2',
      [makeItem(2, 's2', 0)],
      null,
      getClientId(),
    );
    expect(useQueueStore.getState().queues.get('s2')).toHaveLength(1);
  });

  it("stamps its pushes with this window's origin id, not the device id", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      useQueueStore.getState().add('push-s1', makeItem(1, 'push-s1', 0));
      await vi.advanceTimersByTimeAsync(500);

      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/sessions/push-s1/queue');
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.originClientId).toBe(getWindowOriginId());
      expect(body.originClientId).not.toBe(getClientId());
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('applies an update with no origin (a pull, not an echo)', () => {
    // syncFromServer passes null: we asked for this data, so it must apply
    // even though we are the one who requested it.
    useQueueStore.getState().applyRemoteQueue('s1', [makeItem(1, 's1', 0)], null, null);
    expect(useQueueStore.getState().queues.get('s1')).toHaveLength(1);
  });

  it('sorts incoming items by position, not arrival order', () => {
    useQueueStore.getState().applyRemoteQueue(
      's1',
      [makeItem(3, 's1', 2), makeItem(1, 's1', 0), makeItem(2, 's1', 1)],
      null,
      'other',
    );
    expect(useQueueStore.getState().queues.get('s1')!.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('applies an empty remote queue — a clear on one device must propagate', () => {
    useQueueStore.getState().add('s1', makeItem(1, 's1', 0));
    useQueueStore.getState().applyRemoteQueue('s1', [], null, 'other');
    expect(useQueueStore.getState().queues.get('s1')).toEqual([]);
  });

  it('applies remote automation alongside items', () => {
    // A session paused on the desktop must read as paused on the phone, or
    // the two devices disagree about whether the scheduler should fire.
    useQueueStore.getState().applyRemoteQueue(
      's1', [], { ...DEFAULT_AUTOMATION, paused: true }, 'other',
    );
    expect(useQueueStore.getState().getAutomation('s1').paused).toBe(true);
  });

  it('leaves automation untouched when the remote payload has none', () => {
    useQueueStore.getState().setPaused('s1', true);
    useQueueStore.getState().applyRemoteQueue('s1', [makeItem(1, 's1', 0)], null, 'other');
    expect(useQueueStore.getState().getAutomation('s1').paused).toBe(true);
  });

  it('does not touch other sessions', () => {
    useQueueStore.getState().add('s2', makeItem(9, 's2', 0));
    useQueueStore.getState().applyRemoteQueue('s1', [makeItem(1, 's1', 0)], null, 'other');
    expect(useQueueStore.getState().queues.get('s2')).toHaveLength(1);
  });
});
