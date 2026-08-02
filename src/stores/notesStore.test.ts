import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useNotesStore } from './notesStore';

/** A raw SQLite row as the API returns it — snake_case, not the UI's camelCase. */
function makeRow(id: number, createdAt: number, sessionId = 's1') {
  return {
    id,
    session_id: sessionId,
    text: `Note #${id}`,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function mockFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

describe('notesStore', () => {
  beforeEach(() => {
    useNotesStore.setState({ notes: new Map() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('loadNotes', () => {
    it('maps the bare snake_case row array the endpoint returns', async () => {
      mockFetch(() => okJson([makeRow(1, 1000)]));

      const ok = await useNotesStore.getState().loadNotes('s1');

      expect(ok).toBe(true);
      const notes = useNotesStore.getState().notes.get('s1')!;
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ id: 1, sessionId: 's1', createdAt: 1000, text: 'Note #1' });
    });

    it('sorts newest first', async () => {
      mockFetch(() => okJson([makeRow(1, 1000), makeRow(2, 3000), makeRow(3, 2000)]));

      await useNotesStore.getState().loadNotes('s1');

      expect(useNotesStore.getState().notes.get('s1')!.map((n) => n.id)).toEqual([2, 3, 1]);
    });

    it('tolerates a wrapped { notes: [...] } body', async () => {
      mockFetch(() => okJson({ notes: [makeRow(1, 1000)] }));

      await useNotesStore.getState().loadNotes('s1');

      expect(useNotesStore.getState().notes.get('s1')).toHaveLength(1);
    });

    it('keeps sessions separate', async () => {
      mockFetch((url) =>
        url.includes('/s1/') ? okJson([makeRow(1, 1000)]) : okJson([makeRow(2, 1000, 's2'), makeRow(3, 900, 's2')]),
      );

      await useNotesStore.getState().loadNotes('s1');
      await useNotesStore.getState().loadNotes('s2');

      expect(useNotesStore.getState().notes.get('s1')).toHaveLength(1);
      expect(useNotesStore.getState().notes.get('s2')).toHaveLength(2);
    });

    it('reports failure and leaves the cache untouched on a non-ok response', async () => {
      useNotesStore.setState({ notes: new Map([['s1', []]]) });
      mockFetch(() => ({ ok: false, json: async () => ({}) }));

      const ok = await useNotesStore.getState().loadNotes('s1');

      expect(ok).toBe(false);
      expect(useNotesStore.getState().notes.get('s1')).toEqual([]);
    });

    it('reports failure on a network error', async () => {
      mockFetch(() => { throw new Error('offline'); });

      await expect(useNotesStore.getState().loadNotes('s1')).resolves.toBe(false);
    });
  });

  describe('addNote', () => {
    it('POSTs the trimmed text and prepends the echoed row', async () => {
      useNotesStore.setState({ notes: new Map([['s1', [
        { id: 1, sessionId: 's1', text: 'old', createdAt: 1000, updatedAt: 1000 },
      ]]]) });
      const fetchMock = mockFetch(() => okJson(makeRow(2, 5000)));

      const ok = await useNotesStore.getState().addNote('s1', '  fresh  ');

      expect(ok).toBe(true);
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'fresh' });
      expect(useNotesStore.getState().notes.get('s1')!.map((n) => n.id)).toEqual([2, 1]);
    });

    it('does not hit the network for blank text', async () => {
      const fetchMock = mockFetch(() => okJson(makeRow(1, 1000)));

      expect(await useNotesStore.getState().addNote('s1', '   ')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports failure and adds nothing when the server rejects', async () => {
      mockFetch(() => ({ ok: false, json: async () => ({}) }));

      expect(await useNotesStore.getState().addNote('s1', 'hi')).toBe(false);
      expect(useNotesStore.getState().notes.get('s1')).toBeUndefined();
    });
  });

  describe('updateNote', () => {
    const seedTwo = () => {
      useNotesStore.setState({ notes: new Map([['s1', [
        { id: 2, sessionId: 's1', text: 'newer', createdAt: 2000, updatedAt: 2000 },
        { id: 1, sessionId: 's1', text: 'older', createdAt: 1000, updatedAt: 1000 },
      ]]]) });
    };

    it('PUTs to /api/db/notes/:id and replaces the note in place', async () => {
      seedTwo();
      const fetchMock = mockFetch(() =>
        okJson({ ...makeRow(1, 1000), text: 'edited', updated_at: 5000 }),
      );

      const ok = await useNotesStore.getState().updateNote('s1', 1, '  edited  ');

      expect(ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/db/notes/1');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'edited' });
      const notes = useNotesStore.getState().notes.get('s1')!;
      // Order is untouched — an edit must not reshuffle the list under the cursor.
      expect(notes.map((n) => n.id)).toEqual([2, 1]);
      expect(notes[1]).toMatchObject({ text: 'edited', updatedAt: 5000 });
    });

    it('leaves the note untouched when the server rejects the edit', async () => {
      seedTwo();
      mockFetch(() => ({ ok: false, json: async () => ({}) }));

      expect(await useNotesStore.getState().updateNote('s1', 1, 'edited')).toBe(false);
      expect(useNotesStore.getState().notes.get('s1')![1].text).toBe('older');
    });

    it('does not hit the network for blank text', async () => {
      const fetchMock = mockFetch(() => okJson(makeRow(1, 1000)));

      expect(await useNotesStore.getState().updateNote('s1', 1, '   ')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('uploadMedia', () => {
    it('POSTs the file and returns the stored URL', async () => {
      const fetchMock = mockFetch(() =>
        okJson({ id: 'a'.repeat(32), url: '/api/note-media/' + 'a'.repeat(32), mime: 'image/png', bytes: 12 }),
      );

      const result = await useNotesStore
        .getState()
        .uploadMedia('s1', { name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.media.url).toBe('/api/note-media/' + 'a'.repeat(32));
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/db/sessions/s1/note-media');
      expect(init?.method).toBe('POST');
    });

    it('surfaces the server error text so the toast can explain the rejection', async () => {
      mockFetch(() => ({ ok: false, json: async () => ({ error: 'File exceeds the 25 MB limit' }) }));

      const result = await useNotesStore
        .getState()
        .uploadMedia('s1', { name: 'big.mp4', dataUrl: 'data:video/mp4;base64,AAA' });

      expect(result).toEqual({ ok: false, error: 'File exceeds the 25 MB limit' });
    });

    it('never writes uploads into the notes cache', async () => {
      mockFetch(() => okJson({ id: 'b'.repeat(32), url: '/api/note-media/x', mime: 'image/png', bytes: 1 }));

      await useNotesStore.getState().uploadMedia('s1', { name: 'a.png', dataUrl: 'data:image/png;base64,AAA' });

      expect(useNotesStore.getState().notes.get('s1')).toBeUndefined();
    });
  });

  describe('deleteNote', () => {
    it('deletes by row id at /api/db/notes/:id, not nested under the session', async () => {
      useNotesStore.setState({ notes: new Map([['s1', [
        { id: 1, sessionId: 's1', text: 'a', createdAt: 1000, updatedAt: 1000 },
        { id: 2, sessionId: 's1', text: 'b', createdAt: 2000, updatedAt: 2000 },
      ]]]) });
      const fetchMock = mockFetch(() => okJson({ ok: true }));

      const ok = await useNotesStore.getState().deleteNote('s1', 1);

      expect(ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/db/notes/1');
      expect(init?.method).toBe('DELETE');
      expect(useNotesStore.getState().notes.get('s1')!.map((n) => n.id)).toEqual([2]);
    });

    it('keeps the note when the server rejects the delete', async () => {
      useNotesStore.setState({ notes: new Map([['s1', [
        { id: 1, sessionId: 's1', text: 'a', createdAt: 1000, updatedAt: 1000 },
      ]]]) });
      mockFetch(() => ({ ok: false, json: async () => ({}) }));

      expect(await useNotesStore.getState().deleteNote('s1', 1)).toBe(false);
      expect(useNotesStore.getState().notes.get('s1')).toHaveLength(1);
    });
  });
});
