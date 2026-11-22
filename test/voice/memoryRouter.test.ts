import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { DatabaseSync } from 'node:sqlite';
import { createCallMemory, type CallMemory } from '../../server/voice/callMemory.js';
import { createMemoryRouter } from '../../server/voice/memoryRouter.js';
import type { TranscriptLine } from '../../server/voice/transcriptLog.js';

let server: Server;
let base = '';
let memory: CallMemory;
let live: { callId: string; lines: TranscriptLine[] } | null = null;

beforeEach(async () => {
  let n = 0;
  memory = createCallMemory({ db: () => new DatabaseSync(':memory:'), newId: () => `m${(n += 1)}` });
  memory.propose([
    { kind: 'correction', heard: 'central section', meant: 'central session', scope: 'global' },
    { kind: 'preference', heard: 'web work in worktrees', meant: 'Open web work in worktrees', scope: 'project:/shared' },
    { kind: 'preference', heard: 'secret project rule', meant: 'Private project rule', scope: 'project:/private' },
  ], 'call-1');
  const app = express();
  app.use(express.json());
  app.use('/api', createMemoryRouter({
    isLocal: (req) => req.headers['x-remote'] !== '1',
    projectsFor: (isLocal) => (isLocal ? ['/shared', '/private'] : ['/shared']),
    memory,
    liveCall: () => live,
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(method: string, path: string, body?: unknown, remote = false) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(remote && { 'x-remote': '1' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as { success: boolean; data?: { items?: Array<{ id: string; status: string; scope: string; meant: string }>; item?: { status: string; scope: string; meant: string } }; code?: string } };
}

describe('the call memory routes (Nov 22 2026)', () => {
  it('lists everything on this Mac, with the projects it may scope to', async () => {
    const res = await call('GET', '/voice/memory');
    expect(res.status).toBe(200);
    expect(res.json.data?.items?.map((i) => i.id)).toEqual(['m1', 'm2', 'm3']);
    expect((res.json.data as { projects?: string[] }).projects).toEqual(['/shared', '/private']);
  });

  it('shows a phone only global items and the projects it can see', async () => {
    const res = await call('GET', '/voice/memory', undefined, true);
    expect(res.json.data?.items?.map((i) => i.id)).toEqual(['m1', 'm2']);
  });

  it('keeps with a scope and an edited meaning, skips, and retires', async () => {
    const kept = await call('POST', '/voice/memory/m2', { action: 'keep', scope: 'global', meant: 'Use worktrees for web work' });
    expect(kept.json.data?.item).toMatchObject({ status: 'kept', scope: 'global', meant: 'Use worktrees for web work' });
    expect((await call('POST', '/voice/memory/m1', { action: 'skip' })).json.data?.item?.status).toBe('skipped');
    expect((await call('POST', '/voice/memory/m2', { action: 'retire' })).json.data?.item?.status).toBe('retired');
  });

  it('is a 404 for a phone on an item or a scope it cannot see, and a 400 for a bad body', async () => {
    expect((await call('POST', '/voice/memory/m3', { action: 'keep' }, true)).status).toBe(404);
    expect((await call('POST', '/voice/memory/m1', { action: 'keep', scope: 'project:/private' }, true)).status).toBe(404);
    expect((await call('POST', '/voice/memory/nope', { action: 'keep' })).status).toBe(404);
    expect((await call('POST', '/voice/memory/m1', { action: 'keep', extra: 1 })).status).toBe(400);
    expect((await call('POST', '/voice/memory/m1', { action: 'keep', scope: 'project:relative' })).status).toBe(400);
    expect(memory.get('m1')?.status).toBe('proposed');
  });

  it('a phone may keep a shared project’s item', async () => {
    const res = await call('POST', '/voice/memory/m2', { action: 'keep' }, true);
    expect(res.json.data?.item?.status).toBe('kept');
  });
});

describe('POST /voice/memory: a central proposes during a call (Nov 22 2026)', () => {
  const said = (text: string): TranscriptLine => ({ role: 'user', text, startMs: 0, endMs: 1 });
  const voice = (text: string): TranscriptLine => ({ role: 'assistant', text, startMs: 0, endMs: 1 });
  const body = { kind: 'preference', heard: 'always answer me in short sentences', meant: 'Keep spoken answers short', scope: 'global' };

  it('adds a proposal (never a kept item) when the person said it in this call', async () => {
    live = { callId: 'call-9', lines: [said('and always answer me in short sentences please')] };
    const res = await call('POST', '/voice/memory', body);
    expect(res.status).toBe(200);
    expect(res.json.data?.item).toMatchObject({ status: 'proposed' });
    expect(memory.kept()).toEqual([]);
  });

  it('refuses words only the voice said, or nobody, and any call outside a call', async () => {
    live = { callId: 'call-9', lines: [voice('I will always answer you in short sentences')] };
    expect((await call('POST', '/voice/memory', body)).status).toBe(422);
    live = null;
    expect((await call('POST', '/voice/memory', body)).status).toBe(409);
  });

  it('is this Mac only (a phone never proposes)', async () => {
    live = { callId: 'call-9', lines: [said('always answer me in short sentences')] };
    expect((await call('POST', '/voice/memory', body, true)).status).toBe(404);
  });

  it('says so when the same thing was already asked about', async () => {
    live = { callId: 'call-9', lines: [said('central section')] };
    const res = await call('POST', '/voice/memory', { kind: 'correction', heard: 'central section', meant: 'central session', scope: 'global' });
    expect(res.status).toBe(200);
    expect((res.json.data as { duplicate?: boolean }).duplicate).toBe(true);
  });
});

describe('the phone allow-list', () => {
  it('lets a paired phone list and decide (the routes check what it may see)', async () => {
    const { phoneRuleFor } = await import('../../server/mobile/phoneProfile.js');
    expect(phoneRuleFor('GET', '/voice/memory')).toBe('allow');
    expect(phoneRuleFor('POST', '/voice/memory/mem_abc-1')).toBe('allow');
    expect(phoneRuleFor('DELETE', '/voice/memory/mem_abc-1')).toBeNull();
    expect(phoneRuleFor('POST', '/voice/memory')).toBeNull();
  });
});
