// test/chatRouter.test.ts — AASC-41: GET /api/sessions/:id/chat. A remote device reads only a session shared
// with it (hidden and unknown are both 404, so ids can't be probed); pages and cursors come from the readers.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
// Sessions are plain objects and transcripts are synthetic files in a temp dir.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createChatRouter } from '../server/chat/chatRouter.js';
import { resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import type { ChatPage } from '../src/types/chat.js';
import { claude, codex, tempDir, writeJsonl, appendJsonl } from './chatFixtures.js';

const CODEX_ID = '01a1288a-2ace-70c2-95a6-0b63700796e5';
const REMOTE = { 'X-Forwarded-For': '192.168.1.50' };

let tmp = '';
let server: Server;
let base = '';
let transcript = '';
const saved: Record<string, string | undefined> = {};
const sessions = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  saved.HOME = process.env.HOME;
  saved.CODEX_HOME = process.env.CODEX_HOME;
  tmp = realpathSync(tempDir('aasc41-router-'));
  process.env.HOME = join(tmp, 'home');
  process.env.CODEX_HOME = join(tmp, 'codex');
  resetTranscriptLocatorCache();

  transcript = writeJsonl(join(tmp, 'claude.jsonl'), Array.from({ length: 250 }, (_, i) => claude.user(`p${i}`)));
  const day = join(tmp, 'codex', 'sessions', '2026', '10', '15');
  mkdirSync(day, { recursive: true });
  writeJsonl(join(day, `rollout-2026-10-15T10-00-00-${CODEX_ID}.jsonl`), [codex.meta(CODEX_ID), codex.user('hi codex'), codex.assistant('hello')]);

  const project = join(tmp, 'home', 'proj');
  sessions.set('shared', { sessionId: 'shared', cliSource: 'claude', projectPath: project, transcriptPath: transcript, remoteVisible: true });
  sessions.set('hidden', { sessionId: 'hidden', cliSource: 'claude', projectPath: project, transcriptPath: transcript });
  sessions.set('empty', { sessionId: 'empty', cliSource: 'claude', projectPath: project, remoteVisible: true });
  sessions.set('gemini', { sessionId: 'gemini', cliSource: 'gemini', projectPath: project, remoteVisible: true });
  sessions.set(CODEX_ID, { sessionId: CODEX_ID, cliSource: 'codex', projectPath: project, remoteVisible: true });

  const app = express();
  app.use('/api', createChatRouter({ getSession: (id) => (sessions.get(id) as never) ?? null }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, { headers });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: ChatPage; error?: string } };
}

const texts = (page: ChatPage) => page.entries.map((e) => ('text' in e ? e.text : e.kind));

describe('visibility', () => {
  it('answers a remote device 404 for a hidden session and for one that does not exist, alike', async () => {
    const hidden = await get('/sessions/hidden/chat', REMOTE);
    const missing = await get('/sessions/nope/chat', REMOTE);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(JSON.stringify(hidden.body)).not.toContain('p249');
  });

  it('lets a remote device read a shared session', async () => {
    const res = await get('/sessions/shared/chat', REMOTE);
    expect(res.status).toBe(200);
    expect(texts(res.body.data).at(-1)).toBe('p249');
  });

  it('lets the Mac read a session that isn’t shared', async () => {
    const res = await get('/sessions/hidden/chat');
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(200);
  });

  it('answers the Mac 404 too for a session that does not exist', async () => {
    expect((await get('/sessions/nope/chat')).status).toBe(404);
  });
});

describe('GET /sessions/:id/chat', () => {
  it('pages back with before and follows new entries with after', async () => {
    const last = await get('/sessions/shared/chat');
    expect(last.body.success).toBe(true);
    expect(last.body.data).toMatchObject({ cli: 'claude', hasMore: true });
    expect(texts(last.body.data)[0]).toBe('p50');

    const older = await get(`/sessions/shared/chat?before=${encodeURIComponent(last.body.data.before as string)}`);
    expect(texts(older.body.data)).toEqual(Array.from({ length: 50 }, (_, i) => `p${i}`));
    expect(older.body.data.hasMore).toBe(false);

    appendJsonl(transcript, [claude.assistant('fresh')]);
    const newer = await get(`/sessions/shared/chat?after=${encodeURIComponent(last.body.data.after as string)}`);
    expect(texts(newer.body.data)).toEqual(['fresh']);
  });

  it('reads a Codex session’s rollout', async () => {
    const res = await get(`/sessions/${CODEX_ID}/chat`);
    expect(res.body.data.cli).toBe('codex');
    expect(texts(res.body.data)).toEqual(['hi codex', 'hello']);
  });

  it('gives an empty page with no cursors when the session has no transcript', async () => {
    expect((await get('/sessions/empty/chat')).body).toEqual({
      success: true,
      data: { entries: [], before: null, after: null, cli: 'claude', hasMore: false },
    });
    expect((await get('/sessions/gemini/chat')).body.data).toMatchObject({ entries: [], cli: null });
  });

  it('refuses a malformed cursor, or both cursors at once', async () => {
    const bad = await get('/sessions/shared/chat?before=..%2Fetc');
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);
    const last = await get('/sessions/shared/chat');
    const c = encodeURIComponent(last.body.data.after as string);
    expect((await get(`/sessions/shared/chat?before=${c}&after=${c}`)).status).toBe(400);
    expect((await get(`/sessions/shared/chat?after=${c}&after=${c}`)).status).toBe(400);
  });
});
