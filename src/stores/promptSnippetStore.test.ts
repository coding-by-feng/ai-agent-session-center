import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * In-memory stand-in for the `promptSnippets` Dexie table. Only the four calls
 * the store makes are implemented — enough to assert the store's own rules
 * (dedupe, ordering, counters) without booting IndexedDB.
 */
interface FakeRow {
  id: number;
  text: string;
  label: string;
  useCount: number;
  lastUsedAt?: number;
  createdAt: number;
}

const rows = new Map<number, FakeRow>();
let nextId = 1;
/** Set to make the next write throw, for the failure-path assertions. */
let failWrites = false;

const table = {
  add: vi.fn(async (row: Omit<FakeRow, 'id'>) => {
    if (failWrites) throw new Error('write failed');
    const id = nextId++;
    rows.set(id, { ...row, id });
    return id;
  }),
  update: vi.fn(async (id: number, patch: Partial<FakeRow>) => {
    if (failWrites) throw new Error('write failed');
    const current = rows.get(id);
    if (!current) return 0;
    rows.set(id, { ...current, ...patch });
    return 1;
  }),
  delete: vi.fn(async (id: number) => {
    if (failWrites) throw new Error('write failed');
    rows.delete(id);
  }),
  orderBy: vi.fn(() => ({
    reverse: () => ({
      toArray: async () => {
        if (failWrites) throw new Error('read failed');
        return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
      },
    }),
  })),
};

vi.mock('@/lib/db', () => ({ db: { promptSnippets: table } }));

const { usePromptSnippetStore } = await import('./promptSnippetStore');

function reset() {
  rows.clear();
  nextId = 1;
  failWrites = false;
  vi.clearAllMocks();
  usePromptSnippetStore.setState({ snippets: [], loaded: false });
}

const store = () => usePromptSnippetStore.getState();

describe('promptSnippetStore', () => {
  beforeEach(reset);

  describe('save', () => {
    it('keeps a snippet and returns its id', async () => {
      const result = await store().save('/compact');
      expect(result.duplicate).toBe(false);
      expect(result.id).toBe(1);
      expect(store().snippets).toHaveLength(1);
      expect(store().snippets[0].text).toBe('/compact');
    });

    it('stores the text trimmed', async () => {
      await store().save('  /compact \n ');
      expect(store().snippets[0].text).toBe('/compact');
      expect(rows.get(1)?.text).toBe('/compact');
    });

    it('puts the newest snippet first so it is visible without scrolling', async () => {
      await store().save('first');
      await store().save('second');
      expect(store().snippets.map((s) => s.text)).toEqual(['second', 'first']);
    });

    it('is a no-op for blank text and writes nothing', async () => {
      const result = await store().save('   \n ');
      expect(result).toEqual({ id: null, duplicate: false });
      expect(store().snippets).toHaveLength(0);
      expect(table.add).not.toHaveBeenCalled();
    });

    // Regression guard: 🔖 doesn't move, so hitting it twice on the same box is
    // easy. Without dedupe that silently builds a library of identical rows.
    it('does not re-add an exact duplicate', async () => {
      const first = await store().save('/compact');
      const second = await store().save('/compact');
      expect(second).toEqual({ id: first.id, duplicate: true });
      expect(store().snippets).toHaveLength(1);
      expect(table.add).toHaveBeenCalledTimes(1);
    });

    it('dedupes across whitespace-only differences', async () => {
      await store().save('/compact');
      const again = await store().save('\n  /compact  ');
      expect(again.duplicate).toBe(true);
      expect(store().snippets).toHaveLength(1);
    });

    it('treats different text as a new snippet', async () => {
      await store().save('/compact');
      await store().save('/context');
      expect(store().snippets).toHaveLength(2);
    });

    it('stores an optional label, trimmed', async () => {
      await store().save('/compact', '  compact run  ');
      expect(store().snippets[0].label).toBe('compact run');
    });

    it('defaults label to an empty string, never undefined', async () => {
      await store().save('/compact');
      expect(store().snippets[0].label).toBe('');
    });

    it('reports failure without touching in-memory state when the write throws', async () => {
      failWrites = true;
      const result = await store().save('/compact');
      expect(result).toEqual({ id: null, duplicate: false });
      expect(store().snippets).toHaveLength(0);
    });
  });

  describe('hasText', () => {
    it('is true only for an exact (trimmed) match', async () => {
      await store().save('/compact');
      expect(store().hasText('/compact')).toBe(true);
      expect(store().hasText('  /compact ')).toBe(true);
      expect(store().hasText('/compac')).toBe(false);
      expect(store().hasText('/COMPACT')).toBe(false);
    });

    it('is false for blank text, so an empty box never shows a filled bookmark', async () => {
      await store().save('/compact');
      expect(store().hasText('')).toBe(false);
      expect(store().hasText('   ')).toBe(false);
    });
  });

  describe('touch', () => {
    it('increments useCount and stamps lastUsedAt', async () => {
      const { id } = await store().save('/compact');
      await store().touch(id!);
      const snippet = store().snippets[0];
      expect(snippet.useCount).toBe(1);
      expect(snippet.lastUsedAt).toBeTypeOf('number');
      expect(rows.get(id!)?.useCount).toBe(1);
    });

    it('accumulates across repeated inserts', async () => {
      const { id } = await store().save('/compact');
      await store().touch(id!);
      await store().touch(id!);
      await store().touch(id!);
      expect(store().snippets[0].useCount).toBe(3);
    });

    it('ignores an unknown id', async () => {
      await store().touch(999);
      expect(table.update).not.toHaveBeenCalled();
    });
  });

  describe('setLabel', () => {
    it('renames a snippet', async () => {
      const { id } = await store().save('/compact');
      await store().setLabel(id!, 'compact run');
      expect(store().snippets[0].label).toBe('compact run');
    });

    it('clears the name back to an empty string on blank input', async () => {
      const { id } = await store().save('/compact', 'compact run');
      await store().setLabel(id!, '   ');
      expect(store().snippets[0].label).toBe('');
    });

    it('skips a redundant write when the label is unchanged', async () => {
      const { id } = await store().save('/compact', 'compact run');
      await store().setLabel(id!, 'compact run');
      expect(table.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('forgets a snippet', async () => {
      const { id } = await store().save('/compact');
      await store().remove(id!);
      expect(store().snippets).toHaveLength(0);
      expect(rows.has(id!)).toBe(false);
    });

    it('leaves other snippets alone', async () => {
      const first = await store().save('/compact');
      await store().save('/context');
      await store().remove(first.id!);
      expect(store().snippets.map((s) => s.text)).toEqual(['/context']);
    });

    // A failed delete still drops the row from memory: leaving a snippet the
    // user just forgot on screen is worse than a stale DB row, and the next
    // load reconciles.
    it('drops from memory even when the delete throws', async () => {
      const { id } = await store().save('/compact');
      failWrites = true;
      await store().remove(id!);
      expect(store().snippets).toHaveLength(0);
    });
  });

  describe('loadFromDb', () => {
    it('hydrates newest-first and flips loaded', async () => {
      rows.set(1, { id: 1, text: 'older', label: '', useCount: 2, createdAt: 100 });
      rows.set(2, { id: 2, text: 'newer', label: 'n', useCount: 0, createdAt: 200 });
      await store().loadFromDb();
      expect(store().loaded).toBe(true);
      expect(store().snippets.map((s) => s.text)).toEqual(['newer', 'older']);
    });

    it('backfills a missing label / useCount from an older row', async () => {
      rows.set(1, { id: 1, text: 'x', createdAt: 100 } as FakeRow);
      await store().loadFromDb();
      expect(store().snippets[0].label).toBe('');
      expect(store().snippets[0].useCount).toBe(0);
      expect(store().snippets[0].lastUsedAt).toBeNull();
    });

    // Matching the other stores: a failed hydrate must still flip `loaded` so
    // the picker renders an empty library instead of hanging.
    it('flips loaded even when the read throws', async () => {
      failWrites = true;
      await store().loadFromDb();
      expect(store().loaded).toBe(true);
      expect(store().snippets).toEqual([]);
    });
  });
});
