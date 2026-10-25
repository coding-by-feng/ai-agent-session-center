// test/noteMediaMeta.test.ts — GET /api/note-media/:id/meta: what one note media file is (its session, name, type
// and size) as JSON, for the /mcp tool note_media_get. The bytes route cannot say it (it answers the file), and the
// session is what a central's scope is judged by. Only this Mac asks.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  media: new Map<string, { id: string; session_id: string; name: string | null; mime: string; ext: string; bytes: number; created_at: number }>(),
  asked: [] as string[],
}));

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), updateQueueCount: vi.fn(),
  searchSessions: vi.fn(() => ({ sessions: [], total: 0 })), getSessionDetail: vi.fn(() => null),
  deleteSessionCascade: vi.fn(), getDistinctProjects: vi.fn(() => []), fullTextSearch: vi.fn(() => ({ results: [] })),
  searchPrompts: vi.fn(() => ({ prompts: [] })), getNotes: vi.fn(() => []), updateNote: vi.fn(), deleteNote: vi.fn(),
  getNoteSessionId: vi.fn(() => null),
  getNoteMedia: vi.fn((id: string) => {
    data.asked.push(id);
    return data.media.get(id) ?? null;
  }),
  default: {},
}));

vi.mock('../server/noteMedia.js', () => ({
  saveNoteMedia: vi.fn(), deleteNoteMediaForSession: vi.fn(), MAX_MEDIA_BYTES: 1,
  resolveNoteMedia: vi.fn(() => null),
}));

import express from 'express';
import { createServer, type Server } from 'http';

const ID = 'a'.repeat(32);
const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.50' };
let server: Server;
let base = '';

beforeAll(async () => {
  const { createToken } = await import('../server/authManager.js');
  REMOTE.Authorization = `Bearer ${createToken()}`;
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  data.asked.length = 0;
  data.media.clear();
  data.media.set(ID, { id: ID, session_id: 'sess-1', name: 'shot.png', mime: 'image/png', ext: 'png', bytes: 2048, created_at: 1_700_000_000_000 });
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, { headers });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('GET /api/note-media/:id/meta', () => {
  it('answers this Mac with the media’s session, name, type, size, time and URL, and nothing of the file', async () => {
    const res = await get(`/note-media/${ID}/meta`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      id: ID,
      sessionId: 'sess-1',
      name: 'shot.png',
      mime: 'image/png',
      bytes: 2048,
      createdAt: 1_700_000_000_000,
      url: `/api/note-media/${ID}`,
    });
  });

  it('answers a missing media 404, like an unknown id on the bytes route', async () => {
    const res = await get(`/note-media/${'b'.repeat(32)}/meta`);

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Not found' });
  });

  it('does not ask the database about an id that cannot be one of ours', async () => {
    for (const bad of ['abc', 'A'.repeat(32), `${'a'.repeat(31)}g`, `${ID}0`]) {
      expect((await get(`/note-media/${bad}/meta`)).status, bad).toBe(404);
    }

    expect(data.asked).toEqual([]);
  });

  it('is for this Mac only: a remote device gets what an unknown id gets, even for a media of a shared session', async () => {
    const res = await get(`/note-media/${ID}/meta`, REMOTE);

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Not found' });
    expect(data.asked).toEqual([]);
  });

  it('is not on a paired phone’s route list, which opens only the bytes route', async () => {
    const { phoneRuleFor } = await import('../server/mobile/phoneProfile.js');

    expect(phoneRuleFor('GET', `/note-media/${ID}`)).toBe('allow');
    expect(phoneRuleFor('GET', `/note-media/${ID}/meta`)).toBeNull();
  });

  it('leaves the bytes route as it was', async () => {
    const res = await get(`/note-media/${ID}`);

    // The mocked resolver finds no file: 404, from the bytes route's own handler.
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Not found' });
  });
});
