// test/resourceUninstall.test.ts — uninstall and restore over real HTTP.
//
// The only writes the RESOURCES tab can make. Each test gets a fresh home and
// trash folder, because every test moves real files. Pinned here: what moves
// (a skill folder, a single file, a memory file AND its MEMORY.md pointer),
// that it comes back exactly as it was, and every refusal a browser can reach —
// the typed name, a non-JSON body, another local origin, a symlink, a type that
// lives inside a config file, a remote device, a stale scan, an occupied path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createResourceRouter } from '../server/resourceRouter.js';
import { createResourceCatalog } from '../server/resourceCatalog.js';
import { movePath, moveToTrash, placeWithoutReplacing } from '../server/resourceUninstall.js';
import type { ResourceCatalog, ResourceSummary } from '../src/types/resources.js';

const NO_SYMLINKS = process.platform === 'win32';
const MEMORY_DIR = '.claude/projects/-work-proj/memory';
const MEMORY_INDEX = '# Memory Index\n\n- [Foo note](foo.md) — the foo hook\n- [Bar](bar.md) — the bar hook\n';

let base = '';
let home = '';
let trash = '';
let port = 0;
let server: Server | null = null;

function put(rel: string, content: string): void {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

async function start(opts: { remote?: boolean } = {}): Promise<void> {
  const app = express();
  app.use('/api/resources', createResourceRouter({
    sessionProjectPaths: () => [],
    env: {},
    home,
    trashDir: trash,
    ...(opts.remote ? { isLocalRequest: () => false } : {}),
  }));
  server = createServer(app);
  await new Promise<void>((resolveStart) => server?.listen(0, '127.0.0.1', resolveStart));
  const addr = server.address();
  port = addr && typeof addr === 'object' ? addr.port : 0;
}

/** Raw request: `fetch` drops Host/Origin/Sec-Fetch-* overrides, and those are exactly what the write gate judges. */
function raw(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; json: { success?: boolean; data?: unknown; error?: string } }>((resolveReq, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/api/resources${path}`, {
      method,
      headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch { /* asserted on by status */ }
        resolveReq({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SAME_ORIGIN = () => ({ ...JSON_HEADERS, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });

const uninstall = (id: string, confirmName: string, headers: Record<string, string> = JSON_HEADERS) =>
  raw('POST', `/item/${id}/uninstall`, { body: JSON.stringify({ confirmName }), headers });
const restore = (trashId: string, headers: Record<string, string> = JSON_HEADERS) =>
  raw('POST', `/trash/${trashId}/restore`, { body: '{}', headers });

async function scanned(): Promise<ResourceCatalog> {
  for (let i = 0; i < 400; i++) {
    const { json } = await raw('GET', '/');
    const catalog = json.data as ResourceCatalog;
    if (catalog?.state === 'ready' || catalog?.state === 'error') return catalog;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('scan never finished');
}

function find(catalog: ResourceCatalog, type: string, name: string): ResourceSummary {
  const r = catalog.resources.find((x) => x.type === type && x.name === name);
  if (!r) throw new Error(`missing ${type} ${name}: ${catalog.resources.map((x) => `${x.type}:${x.name}`).join(', ')}`);
  return r;
}

const trashEntries = (): string[] => (existsSync(trash) ? readdirSync(trash) : []);

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-uninstall-')));
  home = join(base, 'home');
  trash = join(base, 'trash');
  put('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\nbody\n');
  put('.claude/skills/demo/notes.md', 'plain notes\n');
  put('.claude/commands/ship.md', 'Ship it.\n');
  put(`${MEMORY_DIR}/MEMORY.md`, MEMORY_INDEX);
  put(`${MEMORY_DIR}/foo.md`, '---\nname: foo\n---\nfoo body\n');
  put(`${MEMORY_DIR}/bar.md`, '---\nname: bar\n---\nbar body\n');
  put('.claude/settings.json', JSON.stringify({ model: 'opus' }));
  if (!NO_SYMLINKS) {
    put('../elsewhere/linked-skill/SKILL.md', '---\nname: linked\n---\nowned elsewhere\n');
    symlinkSync(join(base, 'elsewhere/linked-skill'), join(home, '.claude/skills/linked'), 'dir');
  }
  await start();
});

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
  rmSync(base, { recursive: true, force: true });
});

describe('uninstall → trash → restore', () => {
  it('moves a skill folder into the trash, drops it from the catalog at once, and restores it', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    const res = await uninstall(skill.id, 'demo', SAME_ORIGIN());
    expect(res.status).toBe(200);
    const data = res.json.data as { trashId: string; name: string; type: string; path: string };
    expect(data).toMatchObject({ name: 'demo', type: 'skill', path: '~/.claude/skills/demo' });
    expect(data.trashId).toMatch(/^\d{13}-[a-f0-9]{8}$/);

    expect(existsSync(join(home, '.claude/skills/demo'))).toBe(false);
    expect(readFileSync(join(trash, data.trashId, 'payload/demo/SKILL.md'), 'utf8')).toContain('body');
    // Gone from the catalog before any rescan: no stale detail, no stale list row.
    expect((await raw('GET', `/item/${skill.id}`)).status).toBe(404);
    expect(((await raw('GET', '/')).json.data as ResourceCatalog).resources.some((r) => r.id === skill.id)).toBe(false);

    const back = await restore(data.trashId, SAME_ORIGIN());
    expect(back.status).toBe(200);
    expect(back.json.data).toMatchObject({ name: 'demo', path: '~/.claude/skills/demo' });
    expect(readFileSync(join(home, '.claude/skills/demo/SKILL.md'), 'utf8')).toContain('body');
    expect(readFileSync(join(home, '.claude/skills/demo/notes.md'), 'utf8')).toBe('plain notes\n');
    expect(trashEntries()).toEqual([]);
  });

  it('moves a single command file the same way', async () => {
    const command = find(await scanned(), 'command', 'ship');
    const res = await uninstall(command.id, 'ship');
    expect(res.status).toBe(200);
    expect(existsSync(join(home, '.claude/commands/ship.md'))).toBe(false);
    expect((await restore((res.json.data as { trashId: string }).trashId)).status).toBe(200);
    expect(readFileSync(join(home, '.claude/commands/ship.md'), 'utf8')).toBe('Ship it.\n');
  });

  it('memory: also removes its MEMORY.md pointer, and restore puts the line back where it was', async () => {
    const memory = find(await scanned(), 'memory', 'foo.md');
    const res = await uninstall(memory.id, 'foo.md');
    expect(res.status).toBe(200);
    const index = readFileSync(join(home, MEMORY_DIR, 'MEMORY.md'), 'utf8');
    expect(index).not.toContain('(foo.md)');
    expect(index).toContain('- [Bar](bar.md) — the bar hook');

    expect((await restore((res.json.data as { trashId: string }).trashId)).status).toBe(200);
    expect(readFileSync(join(home, MEMORY_DIR, 'MEMORY.md'), 'utf8')).toBe(MEMORY_INDEX);
    expect(readFileSync(join(home, MEMORY_DIR, 'foo.md'), 'utf8')).toContain('foo body');
  });

  it('memory pointers: CRLF, a nested name and duplicate lines all go, and all come back exactly', async () => {
    const index = '# Memory Index\r\n\r\n- [Nested](sub/deep.md) — one\r\n- [Bar](bar.md) — keep\r\n- [Nested again](./sub/deep.md) — two\r\n';
    put(`${MEMORY_DIR}/MEMORY.md`, index);
    put(`${MEMORY_DIR}/sub/deep.md`, '---\nname: deep\n---\ndeep body\n');
    const memory = find(await scanned(), 'memory', 'sub/deep.md');
    const res = await uninstall(memory.id, 'sub/deep.md');
    expect(res.status).toBe(200);
    const edited = readFileSync(join(home, MEMORY_DIR, 'MEMORY.md'), 'utf8');
    expect(edited).not.toContain('sub/deep.md');
    expect(edited).toContain('- [Bar](bar.md) — keep\r');
    expect((await restore((res.json.data as { trashId: string }).trashId)).status).toBe(200);
    expect(readFileSync(join(home, MEMORY_DIR, 'MEMORY.md'), 'utf8')).toBe(index);
  });

  it('drops the uninstalled id from the other copy’s variants at once', async () => {
    put('.codex/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\ncodex body\n');
    const catalog = await scanned();
    const claude = catalog.resources.find((r) => r.type === 'skill' && r.name === 'demo' && r.agent === 'claude');
    const codex = catalog.resources.find((r) => r.type === 'skill' && r.name === 'demo' && r.agent === 'codex');
    if (!claude || !codex) throw new Error('fixture needs both demo copies');
    expect(codex.variantIds).toContain(claude.id);
    expect((await uninstall(claude.id, 'demo')).status).toBe(200);
    const after = (await raw('GET', '/')).json.data as ResourceCatalog;
    expect(after.resources.find((r) => r.id === codex.id)?.variantIds).not.toContain(claude.id);
  });

  it('names where the trash is, so the dialog can say where an uninstalled item stays', async () => {
    // Shown like every other root: `~/…` inside home, absolute elsewhere (as here).
    expect((await scanned()).roots.trash).toBe(trash);
  });

  it('uninstalling MEMORY.md itself touches no other file', async () => {
    const indexFile = find(await scanned(), 'memory', 'MEMORY.md');
    expect((await uninstall(indexFile.id, 'MEMORY.md')).status).toBe(200);
    expect(readFileSync(join(home, MEMORY_DIR, 'foo.md'), 'utf8')).toContain('foo body');
    expect(existsSync(join(home, MEMORY_DIR, 'MEMORY.md'))).toBe(false);
  });
});

describe('refusals', () => {
  it('without the exact name: 400, and nothing moves', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    for (const confirmName of ['Demo', 'demo ', '']) {
      expect((await uninstall(skill.id, confirmName)).status).toBe(400);
    }
    expect(existsSync(join(home, '.claude/skills/demo/SKILL.md'))).toBe(true);
    expect(trashEntries()).toEqual([]);
  });

  it('a body that is not JSON (a cross-site <form> can send these without a preflight): 415', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    const res = await raw('POST', `/item/${skill.id}/uninstall`, {
      body: 'confirmName=demo',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(415);
    expect(existsSync(join(home, '.claude/skills/demo'))).toBe(true);
  });

  it('a write from ANOTHER local page — any localhost port — is 403; the browser marks it same-site', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    // What a browser sends for http://localhost:8080 → http://127.0.0.1:<port>.
    const otherPort = { ...JSON_HEADERS, Origin: 'http://localhost:8080', 'Sec-Fetch-Site': 'same-site' };
    expect((await uninstall(skill.id, 'demo', otherPort)).status).toBe(403);
    const command = find(await scanned(), 'command', 'ship');
    const res = await uninstall(command.id, 'ship');
    expect((await restore((res.json.data as { trashId: string }).trashId, otherPort)).status).toBe(403);
    expect(existsSync(join(home, '.claude/skills/demo'))).toBe(true);
  });

  it('the Vite dev proxy is still the AASC page: same-origin to the browser, Host rewritten', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    const viaProxy = { ...JSON_HEADERS, Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' };
    expect((await uninstall(skill.id, 'demo', viaProxy)).status).toBe(200);
  });

  it.skipIf(NO_SYMLINKS)('a symlinked skill: 403, and the link and its target stay', async () => {
    const linked = find(await scanned(), 'skill', 'linked');
    const res = await uninstall(linked.id, 'linked');
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/link/i);
    expect(existsSync(join(home, '.claude/skills/linked/SKILL.md'))).toBe(true);
    expect(existsSync(join(base, 'elsewhere/linked-skill/SKILL.md'))).toBe(true);
  });

  it('a type that lives inside a config file: 403', async () => {
    const settings = (await scanned()).resources.find((r) => r.type === 'settings');
    if (!settings) throw new Error('fixture has no settings resource');
    expect((await uninstall(settings.id, settings.name)).status).toBe(403);
    expect(existsSync(join(home, '.claude/settings.json'))).toBe(true);
  });

  it('a resource that changed since the scan: 409', async () => {
    const command = find(await scanned(), 'command', 'ship');
    rmSync(join(home, '.claude/commands/ship.md'));
    expect((await uninstall(command.id, 'ship')).status).toBe(409);
    expect(trashEntries()).toEqual([]);
  });

  it.skipIf(NO_SYMLINKS)('a parent folder swapped for a link since the scan: 409, and nothing outside moves', async () => {
    // The file itself is not a link, so only the scan-time realpath check sees
    // that it now resolves somewhere else entirely.
    const command = find(await scanned(), 'command', 'ship');
    const elsewhere = join(base, 'elsewhere-commands');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'ship.md'), 'NOT YOURS\n');
    rmSync(join(home, '.claude/commands'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(home, '.claude/commands'), 'dir');
    expect((await uninstall(command.id, 'ship')).status).toBe(409);
    expect(readFileSync(join(elsewhere, 'ship.md'), 'utf8')).toBe('NOT YOURS\n');
    expect(trashEntries()).toEqual([]);
  });

  it('restore never overwrites what is there now: 409, and the trash entry is kept', async () => {
    const command = find(await scanned(), 'command', 'ship');
    const { trashId } = (await uninstall(command.id, 'ship')).json.data as { trashId: string };
    put('.claude/commands/ship.md', 'a new one\n');
    expect((await restore(trashId)).status).toBe(409);
    expect(readFileSync(join(home, '.claude/commands/ship.md'), 'utf8')).toBe('a new one\n');
    expect(trashEntries()).toEqual([trashId]);
  });

  it.skipIf(NO_SYMLINKS)('restore refuses when the folder it came from now resolves somewhere else', async () => {
    // A pulled commit can turn `.claude/commands` into a link to ~/.claude/rules;
    // restoring through it would put a repo's file in every session's rules.
    const command = find(await scanned(), 'command', 'ship');
    const { trashId } = (await uninstall(command.id, 'ship')).json.data as { trashId: string };
    const elsewhere = join(base, 'global-rules');
    mkdirSync(elsewhere, { recursive: true });
    rmSync(join(home, '.claude/commands'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(home, '.claude/commands'), 'dir');
    expect((await restore(trashId)).status).toBe(409);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(trashEntries()).toEqual([trashId]);
  });

  it('a trash entry whose paths are not normalized is refused as damaged', async () => {
    const command = find(await scanned(), 'command', 'ship');
    const { trashId } = (await uninstall(command.id, 'ship')).json.data as { trashId: string };
    const entryPath = join(trash, trashId, 'entry.json');
    const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    // String-prefix containment would pass this; it resolves to <home>/escape.md.
    writeFileSync(entryPath, JSON.stringify({ ...entry, originalPath: `${home}/.claude/../escape.md` }));
    renameSync(join(trash, trashId, 'payload/ship.md'), join(trash, trashId, 'payload/escape.md'));
    expect((await restore(trashId)).status).toBe(409);
    expect(existsSync(join(home, 'escape.md'))).toBe(false);
  });

  it('a malformed trash id is 400; an unknown one is 404', async () => {
    expect((await restore('..%2F..%2Fetc')).status).toBe(400);
    expect((await restore('1791329416741-deadbeef')).status).toBe(404);
  });
});

describe('uninstall while a scan is running', () => {
  it('is a 409 — the scan may already have listed it and would put it back', async () => {
    const catalog = createResourceCatalog({ sessionProjectPaths: () => [], env: {}, home, trashDir: trash });
    catalog.startScan([]);
    await catalog.whenIdle();
    const ship = catalog.getCatalog().resources.find((r) => r.type === 'command' && r.name === 'ship');
    if (!ship) throw new Error('fixture has no ship command');
    catalog.startScan([]);
    await expect(catalog.uninstall(ship.id, 'ship')).rejects.toMatchObject({ status: 409 });
    await catalog.whenIdle();
    expect(existsSync(join(home, '.claude/commands/ship.md'))).toBe(true);
  });
});

describe('restore while a rescan is running', () => {
  it('queues one more scan, so the restored item is listed when the catalog settles', async () => {
    // Enough files for a measurable hashing phase: by then the scan has finished
    // LISTING folders, so it cannot see a file that comes back during it.
    for (let i = 0; i < 400; i++) put(`.claude/skills/bulk-${i}/SKILL.md`, `---\nname: bulk-${i}\n---\n${'x'.repeat(4000)}\n`);
    const catalog = createResourceCatalog({ sessionProjectPaths: () => [], env: {}, home, trashDir: trash });
    catalog.startScan([]);
    await catalog.whenIdle();
    const listed = () => catalog.getCatalog().resources.some((r) => r.type === 'command' && r.name === 'ship');
    const ship = catalog.getCatalog().resources.find((r) => r.type === 'command' && r.name === 'ship');
    if (!ship) throw new Error('fixture has no ship command');
    const { trashId } = await catalog.uninstall(ship.id, 'ship');

    catalog.startScan([]); // the view's rescan after the uninstall
    for (let i = 0; i < 5000 && catalog.getCatalog().progress?.phase !== 'hashing'; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(catalog.getCatalog().progress?.phase).toBe('hashing');
    await catalog.restore(trashId);
    catalog.startScan([]); // the view's rescan after the restore — it only JOINS the one in flight
    await catalog.whenIdle();
    expect(listed()).toBe(true);
  });
});

describe('a remote device', () => {
  it('cannot tell the write routes exist: both answer 404', async () => {
    const skill = find(await scanned(), 'skill', 'demo');
    await new Promise<void>((done) => server?.close(() => done()));
    await start({ remote: true });
    expect((await uninstall(skill.id, 'demo')).status).toBe(404);
    expect((await restore('1791329416741-deadbeef')).status).toBe(404);
    expect(existsSync(join(home, '.claude/skills/demo'))).toBe(true);
  });
});

describe('movePath', () => {
  it('falls back to copy + remove when rename crosses a device (EXDEV)', async () => {
    const src = join(base, 'move-src');
    await mkdir(join(src, 'nested'), { recursive: true });
    await writeFile(join(src, 'nested/file.md'), 'content\n');
    const dst = join(base, 'move-dst');
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    await movePath(src, dst, { rename: async () => { throw exdev; } });
    expect(existsSync(src)).toBe(false);
    expect(await readFile(join(dst, 'nested/file.md'), 'utf8')).toBe('content\n');
  });

  it('cross-volume: when the source cannot be fully removed after the copy, the trash keeps the complete copy', async () => {
    // The only complete copy is the trash one at that point; cleaning it up on
    // the error used to delete the files that were already gone from the source.
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const request = {
      absPath: join(home, '.claude/skills/demo'), rootPath: join(home, '.claude'),
      type: 'skill' as const, name: 'demo', display: '~/.claude/skills/demo',
    };
    await expect(moveToTrash(request, trash, Date.now(), {
      rename: async () => { throw exdev; },
      rm: async () => { throw eperm; },
    })).rejects.toMatchObject({ status: 409 });
    const [entry] = trashEntries();
    expect(entry).toBeDefined();
    expect(existsSync(join(trash, entry, 'entry.json'))).toBe(true);
    expect(readFileSync(join(trash, entry, 'payload/demo/SKILL.md'), 'utf8')).toContain('body');
    expect(readFileSync(join(trash, entry, 'payload/demo/notes.md'), 'utf8')).toBe('plain notes\n');
  });

  it('placing a restored file never replaces one that appeared at the last moment', async () => {
    const src = join(base, 'from-trash.md');
    const dst = join(base, 'target.md');
    await writeFile(src, 'from the trash\n');
    await writeFile(dst, 'a new one\n');
    await expect(placeWithoutReplacing(src, dst)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(dst, 'utf8')).toBe('a new one\n');
    expect(readFileSync(src, 'utf8')).toBe('from the trash\n');
  });

  it('rethrows any other rename failure and leaves the source alone', async () => {
    const src = join(base, 'keep-src.md');
    await writeFile(src, 'keep\n');
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(movePath(src, join(base, 'x.md'), { rename: async () => { throw eacces; } })).rejects.toThrow('permission denied');
    expect(existsSync(src)).toBe(true);
  });
});
