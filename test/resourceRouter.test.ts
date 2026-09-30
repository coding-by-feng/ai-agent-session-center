// test/resourceRouter.test.ts — /api/resources over real HTTP.
//
// The router is local-only INCLUDING reads: a phone on the LAN must not be able
// to list this machine's skills, MCP servers or settings, and must not even
// learn the feature exists — every route answers 404, never 403. The rest pins
// the input edges a browser can reach: extraRoots validation, `..`/absolute/
// symlink escapes on the file route, credential files inside a package, masked
// config fields, and a compare that returns a real patch.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Delegating spy: every compare still gets a real patch; the L10 test counts
// how many diffs are in flight at once.
vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, createTwoFilesPatch: vi.fn(actual.createTwoFilesPatch) };
});
import * as diffModule from 'diff';
import express, { type Request, type Response } from 'express';
import { createServer, request as httpRequest, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createResourceRouter, isLocalResourceRequest, resourceErrorHandler } from '../server/resourceRouter.js';
import type { ResourceCatalog, ResourceSummary } from '../src/types/resources.js';

// Symlinks need elevated rights on Windows, so fixtures create them only where
// they can exist and the tests that depend on one skip elsewhere — a platform
// that cannot express the fixture is not a failure of the code under test.
const NO_SYMLINKS = process.platform === 'win32';
const link = (target: string, path: string, type?: 'dir'): void => {
  if (!NO_SYMLINKS) symlinkSync(target, path, type);
};

let base = '';
let home = '';
let localUrl = '';
let remoteUrl = '';
const servers: Server[] = [];

function put(rel: string, content: string | Buffer): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

async function listen(router: express.Router): Promise<string> {
  const app = express();
  app.use('/api/resources', router);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', resolveStart));
  const addr = server.address();
  return addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}/api/resources` : '';
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: { success?: boolean; data?: unknown; error?: string } = {};
  try {
    json = JSON.parse(text);
  } catch { /* non-JSON body — asserted on by status */ }
  return { status: res.status, json, text };
}

/** Raw GET — `fetch` silently drops a Host override, and Host is exactly what a rebinding attack controls. */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
  return new Promise((resolveGet, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolveGet({ status: res.statusCode ?? 0, json: JSON.parse(body || 'null') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const post = (url: string, body: unknown) =>
  call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitReady(): Promise<ResourceCatalog> {
  for (let i = 0; i < 400; i++) {
    const { json } = await call(`${localUrl}/`);
    const catalog = json.data as ResourceCatalog;
    if (catalog.state === 'ready' || catalog.state === 'error') return catalog;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('scan never finished');
}

let catalog: ResourceCatalog;
let firstGet: ResourceCatalog;
const byName = (type: string, name: string): ResourceSummary => {
  const r = catalog.resources.find((x) => x.type === type && x.name === name);
  if (!r) throw new Error(`missing ${type} ${name}`);
  return r;
};

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-router-')));
  home = join(base, 'home');
  put('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\nlive line\n');
  put('.claude/skills/demo/notes.md', 'plain notes\n');
  put('.claude/skills/demo/blob.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  put('.claude/skills/demo/.env', 'TOKEN=ROUTER-ENV-SECRET\n');
  put('outside.txt', 'OUTSIDE-THE-PACKAGE');
  link(join(home, 'outside.txt'), join(home, '.claude/skills/demo/escape-link.txt'));
  link(join(home, '.claude/skills/demo/notes.md'), join(home, '.claude/skills/demo/inside-link.md'));
  put('.claude/skills/demo/.git/config', '[remote "origin"]\n  url = https://GIT-REMOTE-SECRET@github.com/x\n');
  link(join(home, '.claude/skills/demo/.git'), join(home, '.claude/skills/demo/docs'), 'dir');
  put('.claude/rules/solo.md', '# only live\n');
  put('.claude/settings.json', JSON.stringify({ model: 'opus', env: { API_TOKEN: 'ROUTER-SETTINGS-SECRET' } }));
  put('Documents/agent-skills/claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\nrepo line\n');

  const deps = { sessionProjectPaths: () => [], env: {}, home };
  localUrl = await listen(createResourceRouter(deps));
  remoteUrl = await listen(createResourceRouter({ ...deps, isLocalRequest: () => false }));

  firstGet = (await call(`${localUrl}/`)).json.data as ResourceCatalog;
  catalog = await waitReady();
}, 30_000);

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  rmSync(base, { recursive: true, force: true });
});

describe('local-only gate', () => {
  it('answers 404 {success:false} to a non-local client on every route, reads included', async () => {
    const id = byName('skill', 'demo').id;
    const responses = await Promise.all([
      call(`${remoteUrl}/`),
      post(`${remoteUrl}/scan`, {}),
      call(`${remoteUrl}/item/${id}`),
      call(`${remoteUrl}/item/${id}/file?path=SKILL.md`),
      call(`${remoteUrl}/item/${id}/compare?against=repo`),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ success: false, error: 'Not found' });
    }
  });

  it('serves a loopback client by default (no isLocalRequest override)', () => {
    expect(catalog.state).toBe('ready');
  });
});

describe('GET / and POST /scan', () => {
  it('starts a scan on the first GET and reports scanning', () => {
    expect(firstGet.state).toBe('scanning');
    expect(firstGet.progress).toBeDefined();
    expect(firstGet.roots.claude).toBe('~/.claude');
    expect(catalog.resources.length).toBeGreaterThan(0);
    expect(catalog.scannedAt).toBeTypeOf('number');
  });

  it.each([
    [{ extraRoots: ['relative/path'] }],
    [{ extraRoots: ['/'] }],
    [{ extraRoots: ['/Users'] }],
    [{ extraRoots: ['/Users/x\0y'] }],
    [{ extraRoots: Array.from({ length: 51 }, (_, i) => `/tmp/p${i}`) }],
    [{ extraRoots: 'not-a-list' }],
  ])('rejects %j with 400', async (body) => {
    const r = await post(`${localUrl}/scan`, body);
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.text).not.toMatch(/\bat .*\.ts:\d+/); // no stack trace
  });

  it('rejects a malformed JSON body with 400 and no stack trace', async () => {
    const r = await call(`${localUrl}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"extraRoots": [' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ success: false });
    expect(r.text).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });

  it('joins the scan in flight; a join with the same roots does not scan again', async () => {
    const first = await post(`${localUrl}/scan`, {});
    const second = await post(`${localUrl}/scan`, {});
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ state: 'scanning' });
    expect(second.json.data).toMatchObject({ state: 'scanning' });
    const startedAt = ((await call(`${localUrl}/`)).json.data as ResourceCatalog).startedAt;
    catalog = await waitReady();
    expect(catalog.startedAt).toBe(startedAt);
  });

  it('honours roots added while a scan is running (the latest request wins, one trailing scan)', async () => {
    const missing = join(base, 'not', 'there');
    await post(`${localUrl}/scan`, {});
    const joined = await post(`${localUrl}/scan`, { extraRoots: [missing] });
    expect(joined.json.data).toMatchObject({ state: 'scanning' });
    catalog = await waitReady();
    expect(catalog.projects.find((p) => p.name === 'there')).toMatchObject({ exists: false, evidence: ['added'] });
  });

  it('keeps a body-parser client error as a 4xx, not a 500', async () => {
    const r = await call(`${localUrl}/scan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=latin1' }, body: '{}',
    });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ success: false });
  });
});

describe('GET /item/:id', () => {
  it('404s an unknown or malformed id', async () => {
    expect((await call(`${localUrl}/item/0123456789abcdef`)).status).toBe(404);
    expect((await call(`${localUrl}/item/not-an-id`)).status).toBe(404);
  });

  it('returns config fields masked, never the raw settings text', async () => {
    const r = await call(`${localUrl}/item/${byName('settings', 'settings.json').id}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('ROUTER-SETTINGS-SECRET');
    const detail = r.json.data as { fields: Array<{ key: string; value: string; masked: boolean }>; body?: string };
    expect(detail.body).toBeUndefined();
    expect(detail.fields.find((f) => f.key === 'env.API_TOKEN')).toMatchObject({ value: '******', masked: true });
    expect(detail.fields.find((f) => f.key === 'model')).toMatchObject({ value: 'opus', masked: false });
  });

  it('returns a skill body without frontmatter, the frontmatter, and the file list', async () => {
    const r = await call(`${localUrl}/item/${byName('skill', 'demo').id}`);
    const detail = r.json.data as { body: string; frontmatter: Record<string, unknown>; files: Array<{ path: string }> };
    expect(detail.body).toBe('live line\n');
    expect(detail.frontmatter).toEqual({ name: 'demo', description: 'Demo skill' });
    expect(detail.files.map((f) => f.path)).toEqual(expect.arrayContaining(['SKILL.md', 'notes.md', '.env']));
    expect(r.text).not.toContain('ROUTER-ENV-SECRET');
  });
});

describe('GET /item/:id/file', () => {
  const file = (rel: string) => call(`${localUrl}/item/${byName('skill', 'demo').id}/file?path=${encodeURIComponent(rel)}`);

  it.each(['../x', '../../.claude/settings.json', '/etc/passwd', ...(NO_SYMLINKS ? [] : ['escape-link.txt']), '.git/config'])(
    'rejects %s with 400',
    async (rel) => {
      const r = await file(rel);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain('OUTSIDE-THE-PACKAGE');
    },
  );

  it('400s a missing path and 404s a missing file', async () => {
    expect((await call(`${localUrl}/item/${byName('skill', 'demo').id}/file`)).status).toBe(400);
    expect((await file('nope.md')).status).toBe(404);
  });

  it('never serves .git, whatever the case or however it is reached', async () => {
    for (const rel of ['.GIT/config', '.Git/config', 'docs/config']) {
      const r = await file(rel);
      expect(r.status, rel).not.toBe(200);
      expect([400, 404], rel).toContain(r.status);
      expect(r.text, rel).not.toContain('GIT-REMOTE-SECRET');
    }
  });

  it('never reads a credential file inside a package (403)', async () => {
    const r = await file('.env');
    expect(r.status).toBe(403);
    expect(r.text).not.toContain('ROUTER-ENV-SECRET');
  });

  it('serves text and flags binary without content', async () => {
    expect((await file('notes.md')).json.data).toEqual({ path: 'notes.md', bytes: 12, content: 'plain notes\n' });
    expect((await file('blob.bin')).json.data).toEqual({ path: 'blob.bin', bytes: 5, binary: true });
  });

  it.skipIf(NO_SYMLINKS)('follows a symlink that stays inside the package', async () => {
    expect((await file('inside-link.md')).json.data).toMatchObject({ content: 'plain notes\n' });
  });

  it('404s the file route for a resource that is not a package', async () => {
    expect((await call(`${localUrl}/item/${byName('rule', 'solo.md').id}/file?path=solo.md`)).status).toBe(404);
  });
});

describe('GET /item/:id/compare', () => {
  it('compares a skill with its repo copy and returns a patch', async () => {
    const r = await call(`${localUrl}/item/${byName('skill', 'demo').id}/compare?against=repo`);
    expect(r.status).toBe(200);
    const cmp = r.json.data as { patch: string; files: Array<{ path: string; status: string }>; right: { path: string } };
    expect(cmp.patch).toContain('-live line');
    expect(cmp.patch).toContain('+repo line');
    expect(cmp.files).toEqual(expect.arrayContaining([
      { path: 'SKILL.md', status: 'changed' },
      { path: 'notes.md', status: 'only-left' },
    ]));
    expect(cmp.right.path).toBe('~/Documents/agent-skills/claude/skills/demo');
    expect(r.text).not.toContain(home);
  });

  it('404s when there is nothing to compare against, 400s a malformed target', async () => {
    const solo = byName('rule', 'solo.md').id;
    expect((await call(`${localUrl}/item/${solo}/compare?against=repo`)).status).toBe(404);
    expect((await call(`${localUrl}/item/${solo}/compare?against=0123456789abcdef`)).status).toBe(404);
    expect((await call(`${localUrl}/item/${solo}/compare?against=../../x`)).status).toBe(400);
  });
});

describe('DNS-rebinding gate (security review H1)', () => {
  const port = () => new URL(localUrl).port;

  it.each([
    ['a foreign Host', () => ({ Host: 'attacker.example' })],
    ['a foreign Host with our port', () => ({ Host: `attacker.example:${port()}` })],
    ['a loopback-looking foreign Host', () => ({ Host: `127.0.0.1.nip.io:${port()}` })],
    ['a foreign Origin', () => ({ Origin: 'http://evil.example' })],
    ['an opaque Origin', () => ({ Origin: 'null' })],
    ['Sec-Fetch-Site: cross-site', () => ({ 'Sec-Fetch-Site': 'cross-site' })],
  ])('404s a loopback request carrying %s', async (_label, headers) => {
    const r = await rawGet(`${localUrl}/`, headers());
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ success: false, error: 'Not found' });
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('serves Host %s:<port> with no Origin', async (host) => {
    const r = await rawGet(`${localUrl}/`, { Host: `${host}:${port()}` });
    expect(r.status).toBe(200);
  });

  it('serves the dev proxy and a same-origin browser request', async () => {
    const r = await rawGet(`${localUrl}/`, {
      Host: `localhost:${port()}`, Origin: 'http://localhost:3332', 'Sec-Fetch-Site': 'same-origin',
    });
    expect(r.status).toBe(200);
  });

  it('isLocalResourceRequest refuses a LAN socket even with a loopback Host', () => {
    const req = (remoteAddress: string, headers: Record<string, string>) =>
      ({ socket: { remoteAddress }, headers }) as unknown as Parameters<typeof isLocalResourceRequest>[0];
    expect(isLocalResourceRequest(req('192.168.1.5', { host: 'localhost:3333' }))).toBe(false);
    expect(isLocalResourceRequest(req('::ffff:127.0.0.1', { host: 'localhost:3333' }))).toBe(true);
    expect(isLocalResourceRequest(req('127.0.0.1', {}))).toBe(false);
  });
});

describe('mounted like server/index.ts (security review L6)', () => {
  // index.ts parses JSON globally BEFORE this router, so a malformed body fails
  // outside it: the router's own error handler never sees that error, and
  // Express's default handler would answer with an HTML stack trace.
  it('answers a malformed body with 400 JSON and no stack trace', async () => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/resources', createResourceRouter({ sessionProjectPaths: () => [], env: {}, home }));
    app.use('/api/resources', resourceErrorHandler);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', resolveStart));
    const addr = server.address();
    const url = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}/api/resources/scan` : '';
    const r = await call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"extraRoots": [' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ success: false, error: 'Invalid JSON body' });
    expect(r.text).not.toMatch(/\bat .*\.(ts|js):\d+/);
  });

  const localReq = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3333' } } as unknown as Request;
  function respond(err: unknown, req: Request = localReq, headersSent = false) {
    const out: { status?: number; body?: unknown; forwarded?: unknown } = {};
    const res = {
      headersSent,
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; return res; },
    };
    resourceErrorHandler(err, req, res as unknown as Response, (e?: unknown) => { out.forwarded = e; });
    return out;
  }

  it.each([
    [{ type: 'entity.parse.failed', status: 400 }, 400, 'Invalid JSON body'],
    [{ type: 'entity.too.large', status: 413 }, 413, 'Request body too large'],
    [{ type: 'charset.unsupported', status: 415 }, 415, 'Invalid request body'],
    [new Error(`boom at ${'/Users/someone/secret/path'}`), 500, 'Internal error'],
  ])('maps %j to %i', (err, status, error) => {
    const out = respond(err);
    expect(out.status).toBe(status);
    expect(out.body).toEqual({ success: false, error });
  });

  it('answers a non-local request 404, like the router, and hands on once headers are sent', () => {
    const remote = { socket: { remoteAddress: '192.168.1.9' }, headers: { host: 'localhost:3333' } } as unknown as Request;
    expect(respond({ type: 'entity.parse.failed' }, remote)).toMatchObject({ status: 404, body: { success: false, error: 'Not found' } });
    const err = new Error('late');
    expect(respond(err, localReq, true)).toEqual({ forwarded: err });
  });
});

describe('POST /scan input edges (security review L7, L8)', () => {
  it.each([
    ['text/plain', '{}'],
    ['application/x-www-form-urlencoded', 'extraRoots=%2Ftmp'],
  ])('refuses a %s body with 415 (a cross-site form can send one without a preflight)', async (type, body) => {
    const r = await call(`${localUrl}/scan`, { method: 'POST', headers: { 'Content-Type': type }, body });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ success: false });
  });

  it.each([['/tmp/..'], ['/Users/x/..'], ['/a/b/../..']])('rejects %s, which only resolves to a 0-1 segment root', async (root) => {
    const r = await post(`${localUrl}/scan`, { extraRoots: [root] });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
  });
});

describe.skipIf(NO_SYMLINKS)('confinement over HTTP (security review M3)', () => {
  let url = '';
  let own = '';
  const idOf = async (type: string, name: string) => {
    for (let i = 0; i < 400; i++) {
      const c = (await call(`${url}/`)).json.data as ResourceCatalog;
      if (c.state === 'ready') return c.resources.find((r) => r.type === type && r.name === name)?.id ?? '';
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('scan never finished');
  };

  beforeAll(async () => {
    own = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-router-m3-')));
    const h = join(own, 'home');
    for (const [rel, content] of Object.entries({
      '.claude/commands/swap.md': 'SWAP-ORIGINAL\n',
      'elsewhere/x.md': 'OUTSIDE-ROUTER-BODY\n',
      'Documents/agent-skills/claude/commands/outside.md': 'repo copy\n',
    })) {
      mkdirSync(dirname(join(h, rel)), { recursive: true });
      writeFileSync(join(h, rel), content);
    }
    symlinkSync(join(h, 'elsewhere', 'x.md'), join(h, '.claude', 'commands', 'outside.md'));
    url = await listen(createResourceRouter({ sessionProjectPaths: () => [], env: {}, home: h }));
  });
  afterAll(() => rmSync(own, { recursive: true, force: true }));

  it('refuses a compare of a file linked outside its root with 403 and says why', async () => {
    const r = await call(`${url}/item/${await idOf('command', 'outside')}/compare?against=repo`);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ success: false, error: expect.stringMatching(/resolves outside ~\/.claude/) });
    expect(r.text).not.toContain('OUTSIDE-ROUTER-BODY');
  });

  it('answers 409 when the file now resolves somewhere else than at scan time', async () => {
    const id = await idOf('command', 'swap');
    expect((await call(`${url}/item/${id}`)).status).toBe(200);
    const swap = join(own, 'home', '.claude', 'commands', 'swap.md');
    rmSync(swap);
    symlinkSync(join(own, 'home', 'elsewhere', 'x.md'), swap);
    const r = await call(`${url}/item/${id}`);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ success: false, error: 'Changed since the last scan — rescan' });
    expect(r.text).not.toContain('OUTSIDE-ROUTER-BODY');
  });
});

describe('every text that leaves the server is redacted (security review M2b)', () => {
  const PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAPEMBODYLINE1', 'q1W2e3R4t5Y6u7I8o9P0PEMBODYLINE2', '-----END RSA PRIVATE KEY-----'].join('\n');
  const LEAKS = ['BODYSECRET', 'FMSECRET', 'FILESECRET', 'FILE-BEARER', 'REPOSECRET', 'MEMORYSECRET', 'HOOKSECRET', 'PEMBODYLINE'];
  let url = '';
  let own = '';
  let ids = new Map<string, string>();

  beforeAll(async () => {
    own = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-router-m2b-')));
    const h = join(own, 'home');
    for (const [rel, content] of Object.entries({
      '.claude/skills/leaky/SKILL.md': `---\nname: leaky\ndescription: Leaky\ntoken: ghp_FMSECRETa1B2c3D4e5\n---\nKey sk-ant-api03-BODYSECRETabcdef here.\n${PEM}\n`,
      '.claude/skills/leaky/notes.md': 'password: FILESECRET123\ncurl -H "Authorization: Bearer FILE-BEARER-TOKEN" x\n',
      'Documents/agent-skills/claude/skills/leaky/SKILL.md': `---\nname: leaky\ndescription: Leaky\n---\nKey sk-ant-api03-REPOSECRETabcdef here.\n${PEM}\n`,
      '.codex/memories/MEMORY.md': 'slack xoxb-MEMORYSECRET-12345\n',
      '.claude/hooks/notify.sh': 'curl -H "Authorization: Bearer HOOKSECRETTOKEN" https://x\n',
    })) {
      mkdirSync(dirname(join(h, rel)), { recursive: true });
      writeFileSync(join(h, rel), content);
    }
    url = await listen(createResourceRouter({ sessionProjectPaths: () => [], env: {}, home: h }));
    for (let i = 0; i < 400; i++) {
      const c = (await call(`${url}/`)).json.data as ResourceCatalog;
      if (c.state === 'ready') {
        ids = new Map(c.resources.map((r) => [`${r.type}:${r.name}`, r.id]));
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  afterAll(() => rmSync(own, { recursive: true, force: true }));

  it('redacts detail bodies of every format, frontmatter included', async () => {
    const texts = await Promise.all(['skill:leaky', 'memory:MEMORY.md', 'hook:notify.sh'].map(async (k) => {
      const r = await call(`${url}/item/${ids.get(k)}`);
      expect(r.status, k).toBe(200);
      expect((r.json.data as { body?: string }).body, k).toBeTruthy();
      return r.text;
    }));
    for (const leak of LEAKS) expect(texts.join(''), leak).not.toContain(leak);
    expect(texts[0]).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('redacts package file content', async () => {
    const r = await call(`${url}/item/${ids.get('skill:leaky')}/file?path=notes.md`);
    expect(r.status).toBe(200);
    expect((r.json.data as { content: string }).content).toBe('password: ******\ncurl -H "Authorization: Bearer ******" x\n');
  });

  it('redacts compare patches — and a private key never appears, in part or whole', async () => {
    const r = await call(`${url}/item/${ids.get('skill:leaky')}/compare?against=repo`);
    expect(r.status).toBe(200);
    const patch = (r.json.data as { patch: string }).patch;
    expect(patch).toContain('-Key sk-ant-******');
    for (const leak of LEAKS) expect(r.text, leak).not.toContain(leak);
  });
});

describe('compare cost (security review L10)', () => {
  let url = '';
  let own = '';
  let pkgId = '';
  const home2 = () => join(own, 'home');

  beforeAll(async () => {
    own = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-router-l10-')));
    for (const [rel, content] of Object.entries({
      '.claude/skills/pkg/SKILL.md': 'live\n',
      '.claude/skills/pkg/extra.md': 'x\n',
      'Documents/agent-skills/claude/skills/pkg/SKILL.md': 'repo\n',
      'Documents/agent-skills/claude/skills/pkg/repo-extra.md': 'y\n',
    })) {
      mkdirSync(dirname(join(home2(), rel)), { recursive: true });
      writeFileSync(join(home2(), rel), content);
    }
    url = await listen(createResourceRouter({ sessionProjectPaths: () => [], env: {}, home: home2() }));
    for (let i = 0; i < 400 && !pkgId; i++) {
      const c = (await call(`${url}/`)).json.data as ResourceCatalog;
      if (c.state === 'ready') pkgId = c.resources.find((r) => r.type === 'skill' && r.name === 'pkg')?.id ?? '';
      else await new Promise((r) => setTimeout(r, 20));
    }
  });
  afterAll(() => rmSync(own, { recursive: true, force: true }));

  it('reuses the scan-time file hashes of both packages instead of re-walking them', async () => {
    rmSync(join(home2(), '.claude/skills/pkg/extra.md'));
    rmSync(join(home2(), 'Documents/agent-skills/claude/skills/pkg/repo-extra.md'));
    writeFileSync(join(home2(), '.claude/skills/pkg/new.md'), 'added after the scan\n');
    const r = await call(`${url}/item/${pkgId}/compare?against=repo`);
    expect((r.json.data as { files: unknown }).files).toEqual([
      { path: 'SKILL.md', status: 'changed' },
      { path: 'extra.md', status: 'only-left' },
      { path: 'repo-extra.md', status: 'only-right' },
    ]);
  });

  it('runs at most 2 compares at once — the rest wait', async () => {
    const spy = vi.mocked(diffModule.createTwoFilesPatch);
    const real = spy.getMockImplementation() as (...args: unknown[]) => unknown;
    let active = 0;
    let peak = 0;
    spy.mockImplementation(((...args: unknown[]) => {
      const opts = (args[6] ?? {}) as { callback?: (patch?: string) => void };
      active += 1;
      peak = Math.max(peak, active);
      return real(...args.slice(0, 6), { ...opts, callback: (patch?: string) => { active -= 1; opts.callback?.(patch); } });
    }) as never);
    try {
      const all = await Promise.all(Array.from({ length: 8 }, () => call(`${url}/item/${pkgId}/compare?against=repo`)));
      expect(all.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      spy.mockImplementation(real as never);
    }
  });
});
