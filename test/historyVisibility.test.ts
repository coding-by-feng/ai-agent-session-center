// test/historyVisibility.test.ts — AASC-29: history, notes, teams and the queue count reach a remote device only
// for sessions shared with it. The old history gate trusted `?sessionId=<any shared session>`, whatever the path read.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
import { EventEmitter } from 'node:events';
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

const data = vi.hoisted(() => ({
  notes: new Map<number, string>([[1, 'hist-shared'], [2, 'hist-hidden']]),
  media: new Map<string, string>([['a'.repeat(32), 'hist-shared'], ['b'.repeat(32), 'hist-hidden']]),
  calls: [] as string[],
}));

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), updateQueueCount: vi.fn(),
  searchSessions: vi.fn(() => { data.calls.push('list'); return { sessions: [], total: 0 }; }),
  getSessionDetail: vi.fn((id: string) => { data.calls.push(`detail:${id}`); return { session: { id } }; }),
  deleteSessionCascade: vi.fn((id: string) => { data.calls.push(`delete:${id}`); }),
  getDistinctProjects: vi.fn(() => { data.calls.push('projects'); return []; }),
  fullTextSearch: vi.fn(() => { data.calls.push('search'); return { results: [] }; }),
  searchPrompts: vi.fn((p: { session?: string }) => { data.calls.push(`prompts:${p.session ?? '*'}`); return { prompts: [] }; }),
  getNotes: vi.fn((id: string) => { data.calls.push(`notes:${id}`); return []; }),
  updateNote: vi.fn((id: number, text: string) => { data.calls.push(`edit:${id}`); return { id, text }; }),
  deleteNote: vi.fn((id: number) => { data.calls.push(`unnote:${id}`); }),
  getNoteSessionId: vi.fn((id: number) => data.notes.get(id) ?? null),
  getNoteMedia: vi.fn((id: string) => (data.media.has(id) ? { id, session_id: data.media.get(id) } : null)),
  default: {},
}));

vi.mock('../server/noteMedia.js', () => ({
  saveNoteMedia: vi.fn(), deleteNoteMediaForSession: vi.fn(), MAX_MEDIA_BYTES: 1,
  resolveNoteMedia: vi.fn(() => { data.calls.push('media'); return null; }),
}));

vi.mock('../server/teamManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/teamManager.js')>();
  const teams: Record<string, { teamId: string; parentSessionId: string; childSessionIds: string[]; teamName: string }> = {
    'team-shared': { teamId: 'team-shared', parentSessionId: 'hist-shared', childSessionIds: [], teamName: 'alpha' },
    'team-hidden': { teamId: 'team-hidden', parentSessionId: 'hist-hidden', childSessionIds: [], teamName: 'beta' },
  };
  return { ...actual, getTeam: (id: string) => teams[id] ?? null, readTeamConfig: () => ({ members: ['m'] }) };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server;
let base = '';
let store: typeof import('../server/sessionStore.js');
const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.50' };

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const { createToken } = await import('../server/authManager.js');
  REMOTE.Authorization = `Bearer ${createToken()}`;
  await store.createTerminalSession('hist-shared', { host: 'localhost', workingDir: '/tmp/hist/s', command: 'claude' });
  await store.createTerminalSession('hist-hidden', { host: 'localhost', workingDir: '/tmp/hist/h', command: 'claude' });
  store.setSessionRemoteVisible('hist-shared', true);
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  data.calls.length = 0;
});

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('history from a remote device', () => {
  it.each([
    ['the session list', 'GET', '/db/sessions?sessionId=hist-shared'],
    ['full-text search', 'GET', '/db/search?query=x&sessionId=hist-shared'],
    ['the project list', 'GET', '/db/projects?sessionId=hist-shared'],
    ['the whole prompt trace', 'GET', '/db/prompts?sessionId=hist-shared'],
    ['a hidden session, naming a shared one', 'GET', '/db/sessions/hist-hidden?sessionId=hist-shared'],
    ['deleting a hidden session, naming a shared one', 'DELETE', '/db/sessions/hist-hidden?sessionId=hist-shared'],
    ['a hidden session’s notes', 'GET', '/db/sessions/hist-hidden/notes?sessionId=hist-shared'],
    ['a hidden session’s prompt trace', 'GET', '/db/prompts?session=hist-hidden'],
  ])('refuses %s', async (_label, method, path) => {
    const res = await call(method, path, REMOTE);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('HISTORY_HOST_ONLY');
    expect(data.calls).toEqual([]);
  });

  it('opens a shared session’s history, notes and prompt trace by the session itself', async () => {
    expect((await call('GET', '/db/sessions/hist-shared', REMOTE)).status).toBe(200);
    expect((await call('GET', '/db/sessions/hist-shared/notes', REMOTE)).status).toBe(200);
    expect((await call('GET', '/db/prompts?session=hist-shared', REMOTE)).status).toBe(200);
    expect(data.calls).toEqual(['detail:hist-shared', 'notes:hist-shared', 'prompts:hist-shared']);
  });
});

describe('notes and media by id from a remote device', () => {
  it('edits and deletes only notes of shared sessions; hidden ones look missing', async () => {
    expect((await call('PUT', '/db/notes/2', REMOTE, { text: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/db/notes/2', REMOTE)).status).toBe(404);
    expect((await call('DELETE', '/db/notes/999', REMOTE)).status).toBe(404);
    expect(data.calls).toEqual([]);
    expect((await call('PUT', '/db/notes/1', REMOTE, { text: 'x' })).status).toBe(200);
    expect((await call('DELETE', '/db/notes/1', REMOTE)).status).toBe(200);
    expect(data.calls).toEqual(['edit:1', 'unnote:1']);
  });

  it('serves media only for shared sessions', async () => {
    expect((await call('GET', `/note-media/${'b'.repeat(32)}`, REMOTE)).status).toBe(404);
    expect(data.calls).toEqual([]);
    await call('GET', `/note-media/${'a'.repeat(32)}`, REMOTE);
    expect(data.calls).toEqual(['media']);
  });
});

describe('teams from a remote device', () => {
  it('reads only the config of a team whose lead session is shared', async () => {
    expect((await call('GET', '/teams/team-hidden/config', REMOTE)).status).toBe(404);
    const shared = await call('GET', '/teams/team-shared/config', REMOTE);
    expect(shared.status).toBe(200);
    expect(shared.json.teamName).toBe('alpha');
  });

  it('can’t attach to a hidden team member’s pane', async () => {
    expect((await call('POST', '/teams/team-hidden/members/hist-hidden/terminal', REMOTE)).status).toBe(404);
  });
});

describe('the Mac itself', () => {
  it('keeps the full history, notes and teams', async () => {
    expect((await call('GET', '/db/sessions')).status).toBe(200);
    expect((await call('GET', '/db/search?query=x')).status).toBe(200);
    expect((await call('GET', '/db/projects')).status).toBe(200);
    expect((await call('GET', '/db/prompts')).status).toBe(200);
    expect((await call('GET', '/db/sessions/hist-hidden')).status).toBe(200);
    expect((await call('PUT', '/db/notes/2', {}, { text: 'x' })).status).toBe(200);
    expect((await call('GET', '/teams/team-hidden/config')).status).toBe(200);
    expect(data.calls).toEqual(['list', 'search', 'projects', 'prompts:*', 'detail:hist-hidden', 'edit:2']);
  });
});

describe('queue count on the live connection', () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    sent: Array<Record<string, unknown>> = [];
    send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw) as Record<string, unknown>); });
    ping = vi.fn();
    terminate = vi.fn();
    close = vi.fn();
    say(msg: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  }

  it('a remote device can’t change a hidden session’s count', async () => {
    const ws = await import('../server/wsManager.js');
    const socket = new FakeSocket();
    ws.handleConnection(socket as never, { clientId: 'ipad-q', label: 'iPad', address: '192.168.1.50', isLocal: false, lineage: 'l-q' });
    socket.say({ type: 'update_queue_count', sessionId: 'hist-hidden', count: 7 });
    socket.say({ type: 'update_queue_count', sessionId: 'hist-shared', count: 3 });
    expect(store.getSession('hist-hidden')?.queueCount ?? 0).toBe(0);
    expect(store.getSession('hist-shared')?.queueCount).toBe(3);
    socket.emit('close');
  });
});
