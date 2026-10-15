// test/skillNoteFavorites.test.ts — AASC-20 M9: a phone reads the user's skill-note favourites through
// the Mac. The only source the Mac's server has is the cloud connection; without one the answer is empty
// and the phone ranks commands without notes. A phone gets key, fav, tags and abbr — nothing else — and
// can reach no other notes or cloud route.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createSkillNoteFavorites,
  createSkillNoteFavoritesRouter,
  toPhoneNote,
  FAVORITES_TTL_MS,
} from '../server/mobile/skillNoteFavorites.js';
import { createPhoneProfile, phoneRuleFor } from '../server/mobile/phoneProfile.js';
import type { CloudConnector, CloudStatus } from '../server/cloud/types.js';
import type { NoteRecord } from '../src/types/skillNotesSync.js';

function record(key: string, value: { fav: boolean; tags?: string[]; abbr?: string; cli?: true }, version = 1, deleted = false): NoteRecord {
  const tags = value.tags ?? [];
  return {
    key,
    value: { fav: value.fav, tags, ...(value.abbr ? { abbr: value.abbr } : {}), ...(value.cli ? { cli: true as const } : {}) },
    version,
    deleted,
    tagDots: tags.map((tag) => ({ tag, dots: [randomUUID()] })),
  };
}

interface FakeCloud extends CloudConnector {
  calls: string[];
  pages: Array<{ records: NoteRecord[]; cursor: string; hasMore: boolean }>;
  state: CloudStatus['state'];
  account: string;
  fail: boolean;
}

function fakeCloud(pages: FakeCloud['pages']): FakeCloud {
  const cloud = {
    calls: [] as string[],
    pages,
    state: 'connected' as CloudStatus['state'],
    account: 'acct-1',
    fail: false,
    client: {
      async request<T>(method: string, path: string): Promise<T> {
        cloud.calls.push(`${method} ${path}`);
        if (cloud.fail) throw new Error('offline');
        const since = new URL(path, 'http://x').searchParams.get('since');
        const index = since ? cloud.pages.findIndex((p) => p.cursor === since) + 1 : 0;
        return cloud.pages[index] as T;
      },
    },
    status(): CloudStatus {
      return {
        state: cloud.state,
        lastError: null,
        connection: cloud.state === 'disconnected' ? null : {
          backendOrigin: 'https://be.example', accountId: cloud.account, deviceId: 'mac', deviceName: 'Mac', generation: 1,
        },
      };
    },
  } as unknown as FakeCloud;
  return cloud;
}

const PAGES = (): FakeCloud['pages'] => [
  {
    records: [
      record('claude:zeta', { fav: false, tags: ['ops'] }),
      record('claude:retouch', { fav: true, abbr: 'rt', cli: true }),
      record('codex:old', { fav: true }, 1, true),
    ],
    cursor: 'c1',
    hasMore: true,
  },
  {
    records: [
      record('claude:alpha', { fav: false, abbr: 'al' }),
      record('claude:zeta', { fav: true, tags: ['ops', 'daily'] }, 2),
    ],
    cursor: 'c2',
    hasMore: false,
  },
];

describe('toPhoneNote', () => {
  it('keeps only key, fav, tags and abbr, and drops deleted or empty notes', () => {
    const note = toPhoneNote(record('claude:retouch', { fav: true, tags: ['x'], abbr: 'rt', cli: true }, 7));
    expect(note).toEqual({ key: 'claude:retouch', fav: true, tags: ['x'], abbr: 'rt' });
    expect(Object.keys(note!).sort()).toEqual(['abbr', 'fav', 'key', 'tags']);
    expect(toPhoneNote(record('claude:gone', { fav: true }, 2, true))).toBeNull();
  });
});

describe('createSkillNoteFavorites', () => {
  it('answers nothing without a cloud connection: the Mac has no notes of its own', async () => {
    expect(await createSkillNoteFavorites({ cloud: null }).read()).toEqual({ source: 'none', entries: [] });
    const cloud = fakeCloud(PAGES());
    cloud.state = 'disconnected';
    expect(await createSkillNoteFavorites({ cloud }).read()).toEqual({ source: 'none', entries: [] });
    expect(cloud.calls).toEqual([]);
  });

  it('pulls every page, keeps the newest version of a note, and ranks favourites first', async () => {
    const cloud = fakeCloud(PAGES());
    const value = await createSkillNoteFavorites({ cloud }).read();
    expect(cloud.calls).toEqual(['GET /v1/skill-notes?limit=100', 'GET /v1/skill-notes?limit=100&since=c1']);
    expect(value.source).toBe('cloud');
    expect(value.entries).toEqual([
      { key: 'claude:retouch', fav: true, tags: [], abbr: 'rt' },
      { key: 'claude:zeta', fav: true, tags: ['ops', 'daily'], abbr: null },
      { key: 'claude:alpha', fav: false, tags: [], abbr: 'al' },
    ]);
  });

  it('answers from one pull for a minute, then pulls again', async () => {
    let t = 1000;
    const cloud = fakeCloud(PAGES());
    const favorites = createSkillNoteFavorites({ cloud, now: () => t });
    await Promise.all([favorites.read(), favorites.read()]);
    await favorites.read();
    expect(cloud.calls).toHaveLength(2); // one pull of two pages, shared
    t += FAVORITES_TTL_MS + 1;
    await favorites.read();
    expect(cloud.calls).toHaveLength(4);
  });

  it('keeps the last pull while offline, and never shows one account\'s notes to another', async () => {
    let t = 0;
    const cloud = fakeCloud(PAGES());
    const favorites = createSkillNoteFavorites({ cloud, now: () => t });
    expect((await favorites.read()).entries).toHaveLength(3);
    t += FAVORITES_TTL_MS + 1;
    cloud.state = 'offline';
    expect((await favorites.read()).entries).toHaveLength(3);
    cloud.state = 'connected';
    cloud.fail = true;
    expect((await favorites.read()).entries).toHaveLength(3);
    cloud.account = 'acct-2';
    expect(await favorites.read()).toEqual({ source: 'none', entries: [] });
  });
});

// ── Through the phone profile ────────────────────────────────────────────────────────────────────────────

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(cloud: CloudConnector | null): Promise<string> {
  const app = express();
  const profile = createPhoneProfile({
    phoneOf: (req) => (req.get('x-phone') ? 'phone-1234567890' : null),
    sharedProjectPaths: () => [],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    foregroundProcess: () => null,
  });
  app.use('/api', profile, createSkillNoteFavoritesRouter(createSkillNoteFavorites({ cloud })));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

describe('GET /api/skill-notes/favorites from a paired phone', () => {
  it('gives the phone its favourites first, in exactly four fields', async () => {
    const base = await serve(fakeCloud(PAGES()));
    const res = await fetch(`${base}/api/skill-notes/favorites`, { headers: { 'x-phone': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { source: string; entries: Array<Record<string, unknown>> };
    expect(Object.keys(body).sort()).toEqual(['entries', 'source']);
    expect(body.entries[0]).toEqual({ key: 'claude:retouch', fav: true, tags: [], abbr: 'rt' });
    expect(body.entries.filter((e) => e.fav).map((e) => e.key)).toEqual(['claude:retouch', 'claude:zeta']);
    for (const entry of body.entries) expect(Object.keys(entry).sort()).toEqual(['abbr', 'fav', 'key', 'tags']);
    const text = JSON.stringify(body);
    for (const leak of ['version', 'tagDots', 'cli', 'deleted', 'backendOrigin', 'accountId', 'be.example']) {
      expect(text).not.toContain(leak);
    }
  });

  it('answers an empty list, not an error, when the Mac has no cloud connection', async () => {
    const base = await serve(null);
    const res = await fetch(`${base}/api/skill-notes/favorites`, { headers: { 'x-phone': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'none', entries: [] });
  });

  it('is GET-only, and a phone reaches no other notes or cloud route', async () => {
    const base = await serve(fakeCloud(PAGES()));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/skill-notes/favorites`, { method, headers: { 'x-phone': '1' } });
      expect(res.status, method).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe('PHONE_NOT_ALLOWED');
    }
    for (const path of [
      '/skill-notes', '/skill-notes/export', '/skill-notes/batch', '/skill-notes/favorites/extra',
      '/resources/cloud/skill-notes', '/resources/cloud/skill-notes/export', '/resources/cloud/status',
      '/resources/cloud/aliases/status', '/cloud/status',
    ]) {
      expect(phoneRuleFor('GET', path), path).toBeNull();
      const res = await fetch(`${base}/api${path}`, { headers: { 'x-phone': '1' } });
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { code?: string }).code, path).toBe('PHONE_NOT_ALLOWED');
    }
    expect(phoneRuleFor('GET', '/skill-notes/favorites')).toBe('allow');
  });
});
