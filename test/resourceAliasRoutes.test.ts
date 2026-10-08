// test/resourceAliasRoutes.test.ts — POST/DELETE /api/resources/aliases over real HTTP.
//
// These routes write files in ~/.claude and ~/.codex, so they sit behind the
// same two gates as Uninstall (local request; JSON body from the AASC page
// itself) and then refuse everything they can: an unknown target, a name that
// would shadow a real skill, and the hand-written or marked-file rules that
// server/resourceAliases.ts pins on its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createResourceRouter } from '../server/resourceRouter.js';

let home = '';
let url = '';
let server: Server;

function put(rel: string, content: string): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

async function post(path: string, body: unknown, init: RequestInit = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { success?: boolean; data?: any; error?: string } };
}
const del = async (body: unknown) => {
  const res = await fetch(`${url}/aliases`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { success?: boolean; data?: any; error?: string } };
};

async function scanned(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${url}/`);
    const json = (await res.json()) as { data?: { state?: string } };
    if (json.data?.state === 'ready') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('scan did not finish');
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'aasc-alias-route-'));
  put('.claude/skills/retouch-ascii-review/SKILL.md', '---\nname: retouch-ascii-review\ndescription: Retouch then sketch\n---\nBody\n');
  put('.claude/skills/plan/SKILL.md', '---\nname: plan\ndescription: Plan\n---\nBody\n');
  put('.codex/config.toml', '');
  const app = express();
  app.use('/api/resources', createResourceRouter({
    sessionProjectPaths: () => [],
    home,
    env: { HOME: home } as NodeJS.ProcessEnv,
    trashDir: join(home, 'trash'),
    isLocalRequest: (req) => req.headers['x-test-remote'] === undefined,
  }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/resources`;
  await fetch(`${url}/`); // start the scan
  await scanned();
});
afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const body = { agent: 'claude', kind: 'skill', target: 'retouch-ascii-review', abbr: 'rar' };

describe('POST /aliases', () => {
  it('writes the Claude command and reports the file', async () => {
    const r = await post('/aliases', body);
    expect(r.status).toBe(200);
    expect(r.json.data.files).toEqual([{ path: '~/.claude/commands/rar.md', action: 'created' }]);
    expect(readFileSync(join(home, '.claude/commands/rar.md'), 'utf8')).toContain('retouch-ascii-review');
  });

  it('may be repeated for the same skill after a rescan lists the alias file itself', async () => {
    await fetch(`${url}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await new Promise((r) => setTimeout(r, 100));
    await scanned();
    const again = await post('/aliases', body);
    expect(again.status).toBe(200);
    expect(again.json.data.files[0].action).toBe('unchanged');
  });

  it('refuses an abbreviation that would shadow a real skill', async () => {
    const r = await post('/aliases', { ...body, abbr: 'plan' });
    expect(r.status).toBe(409);
    expect(existsSync(join(home, '.claude/commands/plan.md'))).toBe(false);
  });

  it('refuses a target the catalog does not have', async () => {
    const r = await post('/aliases', { ...body, target: 'no-such-skill', abbr: 'nsk' });
    expect(r.status).toBe(409);
    expect(existsSync(join(home, '.claude/commands/nsk.md'))).toBe(false);
  });

  it.each([
    [{ ...body, abbr: '../x' }],
    [{ ...body, target: 'a;b' }],
    [{ ...body, agent: 'gemini' }],
    [{ ...body, kind: 'rule' }],
    [{ agent: 'claude' }],
  ])('validates the body %j', async (bad) => {
    expect((await post('/aliases', bad)).status).toBe(400);
  });

  it('wants a JSON body, so a cross-site form cannot send it', async () => {
    const res = await fetch(`${url}/aliases`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(res.status).toBe(415);
  });

  it('wants the AASC page itself, not another localhost page', async () => {
    const r = await post('/aliases', { ...body, abbr: 'zzz' }, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' } });
    expect(r.status).toBe(403);
    expect(existsSync(join(home, '.claude/commands/zzz.md'))).toBe(false);
  });

  it('is invisible to a non-local request', async () => {
    const r = await post('/aliases', body, { headers: { 'content-type': 'application/json', 'x-test-remote': '1' } });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /aliases', () => {
  it('removes the file AASC wrote', async () => {
    await post('/aliases', { ...body, abbr: 'tmp1' });
    const r = await del({ agent: 'claude', kind: 'skill', abbr: 'tmp1' });
    expect(r.status).toBe(200);
    expect(r.json.data.files).toEqual([{ path: '~/.claude/commands/tmp1.md', action: 'removed' }]);
    expect(existsSync(join(home, '.claude/commands/tmp1.md'))).toBe(false);
  });

  it('leaves a hand-written file alone', async () => {
    put('.claude/commands/mine.md', 'hand written\n');
    const r = await del({ agent: 'claude', kind: 'skill', abbr: 'mine' });
    expect(r.json.data.files[0].action).toBe('kept');
    expect(readFileSync(join(home, '.claude/commands/mine.md'), 'utf8')).toBe('hand written\n');
  });

  it('validates the abbreviation (no path escapes)', async () => {
    expect((await del({ agent: 'claude', kind: 'skill', abbr: '../../etc' })).status).toBe(400);
  });
});
