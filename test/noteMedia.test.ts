// test/noteMedia.test.ts — persistent storage for images/video embedded in notes.
// Covers the validation gate (type allow-list, size cap, data-URL shape), the
// id guard that keeps `join` off caller-controlled paths, and the orphan sweep
// that is the only thing bounding note-media/ growth once notes are editable.
import { describe, it, beforeAll, beforeEach, afterAll, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

interface MediaRow {
  id: string;
  session_id: string;
  name: string | null;
  mime: string;
  ext: string;
  bytes: number;
  created_at: number;
}

// Stateful stand-in for the SQLite layer: noteMedia.ts opens no database of its
// own, so mocking db.js keeps this suite runnable regardless of the native
// module's ABI (the reason the other server suites do the same).
const store = vi.hoisted(() => ({
  media: new Map<string, MediaRow>(),
  noteTexts: [] as string[],
}));

vi.mock('../server/db.js', () => ({
  addNoteMedia: vi.fn((row: MediaRow) => {
    store.media.set(row.id, row);
    return row;
  }),
  getNoteMedia: vi.fn((id: string) => store.media.get(id) ?? null),
  getNoteMediaOlderThan: vi.fn((cutoff: number) =>
    [...store.media.values()].filter((r) => r.created_at < cutoff),
  ),
  getNoteMediaBySession: vi.fn((sid: string) =>
    [...store.media.values()].filter((r) => r.session_id === sid),
  ),
  deleteNoteMediaRow: vi.fn((id: string) => {
    store.media.delete(id);
  }),
  isNoteMediaReferenced: vi.fn((id: string) => store.noteTexts.some((t) => t.includes(id))),
  default: {},
}));

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dataRoot: string;
let mod: typeof import('../server/noteMedia.js');

/** 1×1 transparent PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'note-media-test-'));
  // NOTE_MEDIA_DIR is resolved at module load, so the env must be set first.
  process.env.APP_USER_DATA = dataRoot;
  mod = await import('../server/noteMedia.js');
});

afterAll(() => {
  delete process.env.APP_USER_DATA;
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.media.clear();
  store.noteTexts = [];
});

describe('saveNoteMedia', () => {
  it('writes the decoded bytes to disk and records the row', () => {
    const result = mod.saveNoteMedia('s1', 'shot.png', PNG_DATA_URL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.media.url).toBe(`/api/note-media/${result.media.id}`);
    expect(result.media.mime).toBe('image/png');

    const row = store.media.get(result.media.id)!;
    expect(row).toMatchObject({ session_id: 's1', name: 'shot.png', ext: 'png' });

    const onDisk = join(mod.NOTE_MEDIA_DIR, `${result.media.id}.png`);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk)).toEqual(Buffer.from(PNG_B64, 'base64'));
    expect(row.bytes).toBe(Buffer.from(PNG_B64, 'base64').length);
  });

  it('accepts video so a screen recording can be embedded', () => {
    const result = mod.saveNoteMedia('s1', 'demo.mp4', 'data:video/mp4;base64,AAAAIGZ0eXBpc29t');

    expect(result.ok).toBe(true);
    if (result.ok) expect(store.media.get(result.media.id)!.ext).toBe('mp4');
  });

  it('rejects SVG — it can carry script and is served same-origin', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString('base64');

    const result = mod.saveNoteMedia('s1', 'x.svg', `data:image/svg+xml;base64,${svg}`);

    expect(result).toEqual({ ok: false, error: 'unsupported-type' });
    expect(store.media.size).toBe(0);
  });

  it('rejects a non-media MIME type', () => {
    const result = mod.saveNoteMedia('s1', 'x.html', 'data:text/html;base64,PGgxPmhpPC9oMT4=');
    expect(result).toEqual({ ok: false, error: 'unsupported-type' });
  });

  it('rejects anything that is not a base64 data URL', () => {
    expect(mod.saveNoteMedia('s1', 'x', 'https://example.com/x.png')).toEqual({
      ok: false, error: 'invalid-data-url',
    });
    expect(mod.saveNoteMedia('s1', 'x', 'data:image/png;base64,')).toEqual({
      ok: false, error: 'invalid-data-url',
    });
  });

  it('rejects an oversize file without leaving a partial write behind', () => {
    const before = store.media.size;
    const huge = 'A'.repeat(Math.ceil((mod.MAX_MEDIA_BYTES + 1024) / 3) * 4);

    const result = mod.saveNoteMedia('s1', 'big.png', `data:image/png;base64,${huge}`);

    expect(result).toEqual({ ok: false, error: 'too-large' });
    expect(store.media.size).toBe(before);
  });
});

describe('resolveNoteMedia', () => {
  it('resolves a stored file', () => {
    const saved = mod.saveNoteMedia('s1', 'shot.png', PNG_DATA_URL);
    if (!saved.ok) throw new Error('setup failed');

    const resolved = mod.resolveNoteMedia(saved.media.id)!;

    expect(resolved.mime).toBe('image/png');
    expect(resolved.path).toBe(join(mod.NOTE_MEDIA_DIR, `${saved.media.id}.png`));
  });

  it('refuses ids that are not our own hex — no traversal reaches join()', () => {
    for (const bad of ['../../../etc/passwd', 'abc', '', '..%2f..%2fetc', 'A'.repeat(32)]) {
      expect(mod.resolveNoteMedia(bad)).toBeNull();
    }
  });

  it('returns null when the row survives but the file is gone', () => {
    const saved = mod.saveNoteMedia('s1', 'shot.png', PNG_DATA_URL);
    if (!saved.ok) throw new Error('setup failed');
    rmSync(join(mod.NOTE_MEDIA_DIR, `${saved.media.id}.png`), { force: true });

    expect(mod.resolveNoteMedia(saved.media.id)).toBeNull();
  });
});

describe('sweepOrphanNoteMedia', () => {
  /** Insert a row + file directly so `created_at` can be backdated. */
  function seedMedia(id: string, ageMs: number): string {
    mkdirSync(mod.NOTE_MEDIA_DIR, { recursive: true });
    const path = join(mod.NOTE_MEDIA_DIR, `${id}.png`);
    writeFileSync(path, 'x');
    store.media.set(id, {
      id, session_id: 's1', name: 'n.png', mime: 'image/png', ext: 'png',
      bytes: 1, created_at: Date.now() - ageMs,
    });
    return path;
  }

  it('deletes stale uploads that no note references', () => {
    const id = 'a'.repeat(32);
    const path = seedMedia(id, mod.ORPHAN_TTL_MS + 60_000);

    expect(mod.sweepOrphanNoteMedia()).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(store.media.has(id)).toBe(false);
  });

  it('keeps media a note still embeds, however old', () => {
    const id = 'b'.repeat(32);
    const path = seedMedia(id, mod.ORPHAN_TTL_MS * 100);
    store.noteTexts = [`look: ![x](/api/note-media/${id})`];

    expect(mod.sweepOrphanNoteMedia()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('keeps a fresh upload — a note still being typed has no reference yet', () => {
    const id = 'c'.repeat(32);
    const path = seedMedia(id, 60_000);

    expect(mod.sweepOrphanNoteMedia()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

describe('deleteNoteMediaForSession', () => {
  it('removes every file and row for that session, leaving others alone', () => {
    const mine = mod.saveNoteMedia('s1', 'a.png', PNG_DATA_URL);
    const other = mod.saveNoteMedia('s2', 'b.png', PNG_DATA_URL);
    if (!mine.ok || !other.ok) throw new Error('setup failed');

    mod.deleteNoteMediaForSession('s1');

    expect(existsSync(join(mod.NOTE_MEDIA_DIR, `${mine.media.id}.png`))).toBe(false);
    expect(store.media.has(mine.media.id)).toBe(false);
    expect(existsSync(join(mod.NOTE_MEDIA_DIR, `${other.media.id}.png`))).toBe(true);
    expect(store.media.has(other.media.id)).toBe(true);
  });
});
