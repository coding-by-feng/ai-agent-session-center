// test/mcp/tools.notes.test.ts — the notes toolset's P1 reads (server/mcp/tools/notes.ts): note_list (a session's
// notes) and note_media_get (what one note's image or video is). (Writing a note, attaching media and deleting are
// later phases.) A note is Markdown a person wrote: fenced as untrusted in `data` and in the text.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const MEDIA = 'a'.repeat(32);
const MEDIA2 = 'b'.repeat(32);

const s1 = makeSession('s1', { title: 'Fix login' });
const outside = makeSession('out-1', { projectPath: '/b/other', title: 'TOP SECRET' });
const rooms = [makeRoom('r1', ['s1']), makeRoom('r2', ['out-1'])];

interface NotesData {
  id: string; shortId: string; count: number; shown: number;
  notes: Array<{ id: number; createdAt: number; updatedAt: number; text: string; textTruncated: boolean; textLength: number; media: string[] }>;
}

const note = (id: number, text: string, over: Record<string, unknown> = {}) => ({ id, session_id: 's1', text, created_at: 1_000 * id, updated_at: 1_000 * id + 5, ...over });

describe('note_list', () => {
  const notes = [
    note(1, 'Remember to rotate the key'),
    note(2, `Screenshot of the bug ![shot.png](/api/note-media/${MEDIA}) and a clip /api/note-media/${MEDIA2} again ${MEDIA}`),
    note(3, 'Latest thought', { updated_at: 99_999 }),
  ];
  const routes = { 'GET /db/sessions/s1/notes': ok(notes) };

  it('calls GET /db/sessions/<id>/notes, with the full id when given the start of one', async () => {
    const long = makeSession('abcdef123456');
    const { ctx, client } = makeCtx({ sessions: [long], routes: { 'GET /db/sessions/abcdef123456/notes': ok([]) } });

    await run('note_list', { sessionId: 'abcdef' }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/db/sessions/abcdef123456/notes' }]);
  });

  it('lists the notes, the most recently changed first, with their times', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes });

    const data = await dataOf<NotesData>('note_list', { sessionId: 's1' }, ctx);

    expect(data).toMatchObject({ id: 's1', shortId: 's1', count: 3, shown: 3 });
    expect(data.notes.map((n) => n.id)).toEqual([3, 2, 1]);
    expect(data.notes[2]).toMatchObject({ createdAt: 1_000, updatedAt: 1_005, textLength: 26, textTruncated: false });
  });

  it('fences each note’s text in the data, from the session’s source', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes });

    const { notes: listed } = await dataOf<NotesData>('note_list', { sessionId: 's1' }, ctx);

    for (const n of listed) expectFenced(n.text, 'note', 'session:s1');
    expect(listed[2].text).toContain('rotate the key');
  });

  it('names the images and videos a note embeds, each once, by the id note_media_get takes', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes });

    const { notes: listed } = await dataOf<NotesData>('note_list', { sessionId: 's1' }, ctx);

    expect(listed.find((n) => n.id === 2)?.media).toEqual([MEDIA, MEDIA2]);
    expect(listed.find((n) => n.id === 1)?.media).toEqual([]);
  });

  it('cuts a long note at 4 000 characters, shows 50 notes by default (up to 100) and counts the rest', async () => {
    const many = Array.from({ length: 70 }, (_, i) => note(i + 1, i === 69 ? 'n'.repeat(9_000) : `note ${i}`));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /db/sessions/s1/notes': ok(many) } });

    const result = await run('note_list', { sessionId: 's1' }, ctx);
    const data = result.data as NotesData;

    expect(data).toMatchObject({ count: 70, shown: 50 });
    expect(data.notes[0].textTruncated).toBe(true);
    expect(data.notes[0].textLength).toBe(9_000);
    expect(data.notes[0].text.length).toBeLessThan(4_200);
    expect((await dataOf<NotesData>('note_list', { sessionId: 's1', limit: 5 }, ctx)).shown).toBe(5);
    await expect(run('note_list', { sessionId: 's1', limit: 101 }, ctx)).rejects.toThrow(/limit/);
    expect(result.summary).toMatch(/20 more/);
  });

  it('keeps hostile text inside its fence, and puts the rows in one block', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /db/sessions/s1/notes': ok([note(1, HOSTILE)]) } });

    const result = await run('note_list', { sessionId: 's1' }, ctx);

    expectFenced((result.data as NotesData).notes[0].text, 'note');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says so when a session has no notes', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /db/sessions/s1/notes': ok([]) } });

    const result = await run('note_list', { sessionId: 's1' }, ctx);

    expect(result.data).toMatchObject({ count: 0, shown: 0, notes: [] });
    expect(result.summary).toMatch(/has no notes/);
  });

  it('refuses a session out of scope without calling a route, and an unknown one as not found', async () => {
    const { ctx, client } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s1, outside], rooms, routes });

    const refused = await runRefused('note_list', { sessionId: 'out-1' }, ctx);
    const unknown = await runRefused('note_list', { sessionId: 'nobody-here' }, ctx);

    expect(refused.code).toBe('NOT_IN_SCOPE');
    expect(`${refused.message} ${refused.hint}`).not.toMatch(/TOP SECRET|out-1/);
    expect(unknown.code).toBe('NOT_FOUND');
    expect(client.calls).toEqual([]);
  });

  it('skips what is not a note, and changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify([null, 'x', { text: 'no id' }, ...notes])));
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /db/sessions/s1/notes': ok(frozen) } });

    expect((await dataOf<NotesData>('note_list', { sessionId: 's1' }, ctx)).count).toBe(3);
  });

  it('turns a failed route into the refusal its status asks for', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { 'GET /db/sessions/s1/notes': fail(503, 'down') } });

    expect((await runRefused('note_list', { sessionId: 's1' }, ctx)).code).toBe('UNAVAILABLE');
  });
});

interface MediaData {
  id: string; sessionId: string; shortId: string; name: string | null; mime: string; kind: string; bytes: number; createdAt: number;
  url: string; resourceUri: string;
}

describe('note_media_get', () => {
  const meta = (over: Record<string, unknown> = {}) => ok({ id: MEDIA, sessionId: 's1', name: 'shot.png', mime: 'image/png', bytes: 2_048, createdAt: 1_700_000_000_000, url: `/api/note-media/${MEDIA}`, ...over });
  const path = `/note-media/${MEDIA}/meta`;

  it('calls GET /note-media/<id>/meta: the file’s description, never the file', async () => {
    const { ctx, client } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta() } });

    await run('note_media_get', { id: MEDIA }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path }]);
  });

  it('takes an id as the notes make one: 32 hex characters', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta() } });

    for (const bad of ['../x', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '']) {
      await expect(run('note_media_get', { id: bad }, ctx), bad).rejects.toThrow(/id/);
    }
  });

  it('describes the file: its session, name, type, size, time, URL and the resource that answers the same', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta() } });

    const result = await run('note_media_get', { id: MEDIA }, ctx);
    const data = result.data as MediaData;

    expect(data).toEqual({
      id: MEDIA, sessionId: 's1', shortId: 's1', name: 'shot.png', mime: 'image/png', kind: 'image', bytes: 2_048, createdAt: 1_700_000_000_000,
      url: `/api/note-media/${MEDIA}`, resourceUri: `aasc://notes/media/${MEDIA}`,
    });
    expect(result.summary).toMatch(/image\/png/);
    expect(result.summary).toMatch(/not sent/i);
  });

  it('does not send the central to a resource for the bytes: the resource answers this same description', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta() } });

    const result = await run('note_media_get', { id: MEDIA }, ctx);
    const tool = allTools().find((t) => t.name === 'note_media_get');

    // The words say what this is (type, size, owner) and that the bytes are not available through MCP in P1.
    expect(result.summary).toMatch(/bytes are not sent through MCP/i);
    expect(result.summary).not.toMatch(/read the resource/i);
    expect(result.summary).not.toContain('aasc://');
    expect(tool?.description).toMatch(/bytes are not available through MCP/i);
    expect(tool?.description).toMatch(/type and size/i);
    expect(tool?.description).not.toMatch(/MCP resource|resource that reads|aasc:\/\//i);
  });

  it('calls a video a video and anything else other', async () => {
    const video = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta({ mime: 'video/mp4', name: null }) } });
    const odd = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta({ mime: 'application/zip' }) } });

    expect((await dataOf<MediaData>('note_media_get', { id: MEDIA }, video.ctx))).toMatchObject({ kind: 'video', name: null });
    expect((await dataOf<MediaData>('note_media_get', { id: MEDIA }, odd.ctx)).kind).toBe('other');
  });

  it('keeps the file’s name inside a block in the text, whatever it says', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: meta({ name: HOSTILE }) } });

    const result = await run('note_media_get', { id: MEDIA }, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  describe('scope: the media’s session must be one the central may see', () => {
    it('gives a global central any media, even of a session the store no longer holds', async () => {
      const { ctx } = makeCtx({ sessions: [], routes: { [`GET ${path}`]: meta({ sessionId: 'long-gone' }) } });

      await expect(run('note_media_get', { id: MEDIA }, ctx)).resolves.toBeDefined();
    });

    it('gives a room or project central the media of its sessions', async () => {
      const room = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s1, outside], rooms, routes: { [`GET ${path}`]: meta() } });
      const project = makeCtx({ central: makeCentral('project', '/a/proj'), sessions: [s1, outside], rooms, routes: { [`GET ${path}`]: meta() } });

      await expect(run('note_media_get', { id: MEDIA }, room.ctx)).resolves.toBeDefined();
      await expect(run('note_media_get', { id: MEDIA }, project.ctx)).resolves.toBeDefined();
    });

    it('refuses the media of another session, of one the store does not hold, and of none, saying nothing of them', async () => {
      for (const owner of ['out-1', 'long-gone', undefined]) {
        for (const central of [makeCentral('room', 'r1'), makeCentral('project', '/a/proj')]) {
          const { ctx } = makeCtx({ central, sessions: [s1, outside], rooms, routes: { [`GET ${path}`]: meta({ sessionId: owner }) } });

          const err = await runRefused('note_media_get', { id: MEDIA }, ctx);

          expect(err.code, `${owner} ${central.kind}`).toBe('NOT_IN_SCOPE');
          expect(`${err.message} ${err.hint}`).not.toMatch(/out-1|long-gone|TOP SECRET|shot\.png/);
        }
      }
    });
  });

  it('answers a media the server does not have as not found, never repeating the id', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: fail(404, 'Not found') } });

    const err = await runRefused('note_media_get', { id: MEDIA }, ctx);

    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint}`).not.toContain(MEDIA);
  });

  it('says it is unavailable where this build of AASC cannot describe media (the app’s page answers the route)', async () => {
    const { ctx } = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: ok(null) } });

    const err = await runRefused('note_media_get', { id: MEDIA }, ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(`${err.message} ${err.hint}`).not.toContain(MEDIA);
  });

  it('tolerates a loose answer, and changes nothing it reads', async () => {
    const loose = makeCtx({ sessions: [s1], routes: { [`GET ${path}`]: ok(deepFreeze({ sessionId: 's1', mime: 7, bytes: 'many' })) } });

    const data = await dataOf<MediaData>('note_media_get', { id: MEDIA }, loose.ctx);

    expect(data).toMatchObject({ id: MEDIA, mime: '', kind: 'other', bytes: 0, name: null });
    expect(everything({ data, summary: '' })).not.toContain('base64');
  });
});
