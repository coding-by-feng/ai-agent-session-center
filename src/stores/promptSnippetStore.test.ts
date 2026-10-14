import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The saved-prompt library is kept on the Mac (AASC-20). A small fake of the
 * Mac's /api/snippets routes stands in for the server, so these tests assert
 * the store's own rules (trim, dedupe, ordering, counters, revisions, the
 * one-time import) without a network.
 */
interface ServerSnippet {
  id: number;
  text: string;
  label: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

const server = {
  rows: new Map<number, ServerSnippet>(),
  nextId: 1,
  revision: 100,
  clock: 1_000,
  /** Set to make every request fail, for the offline paths. */
  down: false,
  imports: [] as unknown[],
};

function list() {
  return {
    revision: server.revision,
    snippets: [...server.rows.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  if (server.down) throw new Error('offline');
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  const changed = () => { server.revision++; return list(); };
  if (url === '/api/snippets' && method === 'GET') return json(list());
  if (url === '/api/snippets' && method === 'POST') {
    const text = String(body.text);
    const hit = [...server.rows.values()].find((r) => r.text === text);
    if (hit) return json({ id: hit.id, duplicate: true, ...list() });
    const id = server.nextId++;
    server.rows.set(id, { id, text, label: String(body.label ?? ''), useCount: 0, lastUsedAt: null, createdAt: server.clock++ });
    return json({ id, duplicate: false, ...changed() });
  }
  if (url === '/api/snippets/import' && method === 'POST') {
    server.imports.push(body.snippets);
    for (const s of body.snippets as ServerSnippet[]) {
      if ([...server.rows.values()].some((r) => r.text === s.text)) continue;
      const id = server.nextId++;
      server.rows.set(id, { ...s, id });
    }
    return json({ added: 1, ...changed() });
  }
  const m = url.match(/^\/api\/snippets\/(\d+)(\/use)?$/);
  if (m) {
    const id = Number(m[1]);
    const row = server.rows.get(id);
    if (method === 'DELETE') { server.rows.delete(id); return json(changed()); }
    if (!row) return json({ error: 'No such saved prompt' }, 404);
    if (m[2]) server.rows.set(id, { ...row, useCount: row.useCount + 1, lastUsedAt: server.clock++ });
    else server.rows.set(id, { ...row, label: String(body.label) });
    return json(changed());
  }
  return json({ error: 'unknown' }, 404);
});

/** This browser's IndexedDB library from before the move to the Mac. */
const localRows: Array<{ id: number; text: string; label: string; useCount: number; lastUsedAt?: number; createdAt: number }> = [];
vi.mock('@/lib/db', () => ({
  db: {
    promptSnippets: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [...localRows].sort((a, b) => b.createdAt - a.createdAt) }) }),
    },
  },
}));

const { usePromptSnippetStore, SNIPPETS_IMPORTED_KEY } = await import('./promptSnippetStore');

const store = () => usePromptSnippetStore.getState();

beforeEach(() => {
  server.rows.clear();
  server.nextId = 1;
  server.revision = 100;
  server.down = false;
  server.imports = [];
  localRows.length = 0;
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  usePromptSnippetStore.setState({ snippets: [], loaded: false, revision: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('promptSnippetStore (kept on the Mac)', () => {
  describe('save', () => {
    it('keeps a snippet and returns its id', async () => {
      const result = await store().save('run the tests');
      expect(result).toEqual({ id: 1, duplicate: false });
      expect(store().snippets.map((s) => s.text)).toEqual(['run the tests']);
    });

    it('sends the text trimmed and a label trimmed, defaulting to an empty string', async () => {
      await store().save('  spaced  ', '  name  ');
      await store().save('unnamed');
      expect(store().snippets.find((s) => s.text === 'spaced')?.label).toBe('name');
      expect(store().snippets.find((s) => s.text === 'unnamed')?.label).toBe('');
    });

    it('puts the newest snippet first so it is visible without scrolling', async () => {
      await store().save('first');
      await store().save('second');
      expect(store().snippets.map((s) => s.text)).toEqual(['second', 'first']);
    });

    it('is a no-op for blank text and never calls the Mac', async () => {
      expect(await store().save('   ')).toEqual({ id: null, duplicate: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not re-add an exact duplicate, across whitespace-only differences', async () => {
      await store().save('same');
      fetchMock.mockClear();
      expect(await store().save('  same ')).toEqual({ id: 1, duplicate: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports failure without touching the list when the Mac can’t be reached', async () => {
      server.down = true;
      expect(await store().save('lost')).toEqual({ id: null, duplicate: false });
      expect(store().snippets).toEqual([]);
    });
  });

  describe('hasText', () => {
    it('is true only for an exact (trimmed) match, and false for blank text', async () => {
      await store().save('exact');
      expect(store().hasText(' exact ')).toBe(true);
      expect(store().hasText('exac')).toBe(false);
      expect(store().hasText('   ')).toBe(false);
    });
  });

  describe('touch, setLabel, remove', () => {
    it('counts uses on the Mac', async () => {
      const { id } = await store().save('used');
      await store().touch(id!);
      await store().touch(id!);
      expect(store().snippets[0]).toMatchObject({ useCount: 2 });
      expect(store().snippets[0].lastUsedAt).not.toBeNull();
    });

    it('ignores an unknown id without calling the Mac', async () => {
      await store().touch(99);
      await store().setLabel(99, 'x');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renames, clears a name, and skips a redundant rename', async () => {
      const { id } = await store().save('named', 'old');
      await store().setLabel(id!, '  new ');
      expect(store().snippets[0].label).toBe('new');
      fetchMock.mockClear();
      await store().setLabel(id!, 'new');
      expect(fetchMock).not.toHaveBeenCalled();
      await store().setLabel(id!, '   ');
      expect(store().snippets[0].label).toBe('');
    });

    it('forgets a snippet at once and leaves the others', async () => {
      const a = await store().save('a');
      await store().save('b');
      await store().remove(a.id!);
      expect(store().snippets.map((s) => s.text)).toEqual(['b']);
    });
  });

  describe('revisions', () => {
    it('keeps the newest list: a late broadcast never rolls it back', async () => {
      await store().save('newer');
      const held = store().revision;
      store().applyServerList({ revision: held - 1, snippets: [] });
      expect(store().snippets.map((s) => s.text)).toEqual(['newer']);
      store().applyServerList({ revision: held + 1, snippets: [] });
      expect(store().snippets).toEqual([]);
    });
  });

  describe('loadFromDb', () => {
    it('loads the Mac’s library', async () => {
      server.rows.set(7, { id: 7, text: 'from the mac', label: '', useCount: 0, lastUsedAt: null, createdAt: 5 });
      await store().loadFromDb();
      expect(store().loaded).toBe(true);
      expect(store().snippets.map((s) => s.text)).toEqual(['from the mac']);
    });

    it('imports this browser’s old library once, then never again', async () => {
      localRows.push({ id: 1, text: ' old browser prompt ', label: 'b', useCount: 4, createdAt: 2 });
      await store().loadFromDb();
      expect(server.imports).toEqual([[{ text: 'old browser prompt', label: 'b', useCount: 4, lastUsedAt: null, createdAt: 2 }]]);
      expect(store().snippets.map((s) => s.text)).toEqual(['old browser prompt']);
      expect(localStorage.getItem(SNIPPETS_IMPORTED_KEY)).toBe('1');
      await store().loadFromDb();
      expect(server.imports).toHaveLength(1);
    });

    it('marks an empty browser library as imported without calling the import', async () => {
      await store().loadFromDb();
      expect(server.imports).toEqual([]);
      expect(localStorage.getItem(SNIPPETS_IMPORTED_KEY)).toBe('1');
    });

    it('shows this browser’s library while the Mac can’t be reached, and imports nothing', async () => {
      localRows.push({ id: 3, text: 'offline copy', label: '', useCount: 0, createdAt: 1 });
      server.down = true;
      await store().loadFromDb();
      expect(store().loaded).toBe(true);
      expect(store().snippets.map((s) => s.text)).toEqual(['offline copy']);
      expect(localStorage.getItem(SNIPPETS_IMPORTED_KEY)).toBeNull();
    });
  });
});
