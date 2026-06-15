import { describe, it, expect, beforeEach } from 'vitest';
import { useQueueStore, type QueueItem } from './queueStore';
import { clearLocalStorage } from '../__tests__/setup';

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

  it('enabling auto-enter also enables auto-send (so a queued prompt actually fires)', () => {
    // Reproduce the reported broken state: Auto-send OFF, Auto-Enter about to go ON.
    useQueueStore.getState().setAutoSend('s1', false);
    expect(useQueueStore.getState().getAutomation('s1').autoSend).toBe(false);

    // Turning Auto-Enter ON must also turn Auto-send ON — "Auto-Enter on" should
    // always mean the prompt is actually sent AND submitted.
    useQueueStore.getState().setAutoEnter('s1', true);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoEnter).toBe(true);
    expect(cfg.autoSend).toBe(true);
  });

  it('disabling auto-enter leaves auto-send untouched (auto-fire + typed-only is valid)', () => {
    useQueueStore.getState().setAutoSend('s1', true);
    useQueueStore.getState().setAutoEnter('s1', false);
    const cfg = useQueueStore.getState().getAutomation('s1');
    expect(cfg.autoEnter).toBe(false);
    expect(cfg.autoSend).toBe(true);
  });
});
