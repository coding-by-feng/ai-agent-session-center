import { describe, it, expect, beforeEach } from 'vitest';
import { useQueueStore, type QueueItem } from './queueStore';

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
  });
});
