import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { spawn } from 'child_process';
import express from 'express';
import { createServer, type Server } from 'http';
import { REMOTE_HELPER } from '../server/resourceTransfers/remoteHelper.js';
import {
  digest,
  packetHash,
  readTransferPacket,
  type PacketFile,
} from '../server/resourceTransfers/packet.js';
import {
  createTransferService,
  type TransferState,
  type TransferStore,
} from '../server/resourceTransfers/service.js';
import { createResourceCatalog } from '../server/resourceCatalog.js';
import { createResourceRouter } from '../server/resourceRouter.js';
import type { TransferTask } from '../src/types/resourceTransfers.js';

let base: string, home: string, source: string;
const servers: Server[] = [];
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'aasc-transfer-test-')));
  home = join(base, 'destination');
  source = join(base, 'source');
  await mkdir(home);
  await mkdir(source);
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  await rm(base, { recursive: true, force: true });
});
async function put(path: string, body = 'test\n') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
function files(text = 'new skill\n'): PacketFile[] {
  return [
    {
      path: 'SKILL.md',
      content: Buffer.from(text).toString('base64'),
      hash: digest(text),
      mode: 0o644,
    },
    {
      path: 'scripts/run.sh',
      content: Buffer.from('echo run\n').toString('base64'),
      hash: digest('echo run\n'),
      mode: 0o755,
    },
  ];
}
function remote(req: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', REMOTE_HELPER], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('error', reject);
    child.on('close', () => {
      try {
        const v = JSON.parse(out);
        v.ok ? resolve(v.data) : reject(new Error(v.error));
      } catch (e) {
        reject(new Error(err || String(e)));
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}
const location = () => ({
  agent: 'claude',
  kind: 'package',
  relativePath: 'skills/demo',
  expectedDestinationPath: join(home, '.claude/skills/demo'),
});
const apply = (
  packet = files(),
  expectedHash: string | null = null,
  operationId = randomUUID(),
) => ({
  ...location(),
  op: 'apply',
  files: packet,
  sourceHash: packetHash(packet),
  expectedHash,
  operationId,
});

it('copies an entire package, verifies modes and bytes, and retries idempotently', async () => {
  const req = apply();
  expect((await remote({ ...location(), op: 'inspect' })).hash).toBeNull();
  const result = await remote(req);
  expect(result.hash).toBe(req.sourceHash);
  expect(await readFile(join(home, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('new skill\n');
  expect((await stat(join(home, '.claude/skills/demo/scripts/run.sh'))).mode & 0o777).toBe(0o755);
  expect(await remote(req)).toEqual(result);
});
it('backs up a replacement and restores only an unchanged destination, including restore retries', async () => {
  await put(join(home, '.claude/skills/demo/SKILL.md'), 'original\n');
  const before = await remote({ ...location(), op: 'inspect' });
  const req = apply(files(), before.hash);
  const result = await remote(req);
  expect(result.backupId).toBe(req.operationId);
  await put(join(home, '.claude/skills/demo/SKILL.md'), 'edited after copy\n');
  await expect(remote({ ...req, op: 'restore' })).rejects.toThrow(/changed after transfer/);
  await put(join(home, '.claude/skills/demo/SKILL.md'), 'new skill\n');
  expect(await remote({ ...req, op: 'restore' })).toEqual({ restored: true });
  expect(await readFile(join(home, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('original\n');
  expect(await remote({ ...req, op: 'restore' })).toEqual({ restored: true });
});
it('supports standalone rule files and checks the reviewed destination path', async () => {
  const body = 'allow test\n';
  const packet = [
    {
      path: 'test.md',
      content: Buffer.from(body).toString('base64'),
      hash: digest(body),
      mode: 0o644,
    },
  ];
  const req = {
    ...apply(packet),
    kind: 'file',
    relativePath: 'rules/test.md',
    expectedDestinationPath: join(home, '.claude/rules/test.md'),
  };
  await remote(req);
  expect((await remote({ ...req, op: 'inspect' })).hash).toBe(req.sourceHash);
  await expect(
    remote({
      ...req,
      operationId: randomUUID(),
      expectedDestinationPath: join(home, '.claude/rules/other.md'),
    }),
  ).rejects.toThrow(/root changed/);
});
it('refuses changed destinations, corrupt packets, path traversal and symbolic links without overwriting', async () => {
  const req = apply();
  await put(join(home, '.claude/skills/demo/SKILL.md'), 'concurrent\n');
  await expect(remote(req)).rejects.toThrow(/changed since comparison/);
  expect(await readFile(join(home, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('concurrent\n');
  await expect(
    remote({ ...req, relativePath: 'skills/../../.ssh/authorized_keys' }),
  ).rejects.toThrow(/Invalid resource path/);
  await expect(remote({ ...req, op: 'inspect', project: dirname(home) })).rejects.toThrow(
    /inside the remote home/,
  );
  await expect(
    remote({
      ...apply(),
      expectedHash: (await remote({ ...location(), op: 'inspect' })).hash,
      files: [{ ...files()[0], hash: 'wrong' }],
    }),
  ).rejects.toThrow(/checksum/);
  await symlink(join(home, '.claude/skills/demo'), join(home, '.claude/skills/linked'));
  await expect(
    remote({ ...location(), op: 'inspect', relativePath: 'skills/linked' }),
  ).rejects.toThrow(/symbolic link/);
});
it('recovers a dead remote worker between backup and installation', async () => {
  const req = apply(),
    dest = join(home, '.claude/skills/demo');
  const original = files('original\n');
  const dir = join(home, '.aasc-resource-transfers', req.operationId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await put(join(dir, 'backup/SKILL.md'), 'original\n');
  // Only one old file exists in this simulated backup.
  const originalHash = packetHash([original[0]]);
  await writeFile(
    join(dir, 'receipt.json'),
    JSON.stringify({
      destination: dest,
      hash: req.sourceHash,
      originalHash,
      hadOriginal: true,
      state: 'prepared',
    }),
  );
  await mkdir(dirname(dest), { recursive: true });
  const lock = join(
    home,
    '.aasc-resource-transfers',
    'lock-' + createHash('sha256').update(dest).digest('hex'),
  );
  await mkdir(lock);
  await writeFile(join(lock, 'owner-2147483647-' + randomUUID()), '');
  const result = await remote({ ...req, expectedHash: originalHash });
  expect(result.hash).toBe(req.sourceHash);
  expect(await readFile(join(dir, 'backup/SKILL.md'), 'utf8')).toBe('original\n');
});
async function catalogFixture() {
  await put(join(source, '.claude/skills/demo/SKILL.md'), '# Demo\n');
  const catalog = createResourceCatalog({ home: source, env: {}, sessionProjectPaths: () => [] });
  catalog.startScan();
  await catalog.whenIdle();
  return catalog;
}
it('refuses source credentials and symlinks, and discovers referenced shared packages', async () => {
  const catalog = await catalogFixture();
  const resource = catalog.transferInternals().find((r) => r.summary.name === 'demo')!;
  expect((await readTransferPacket(resource)).files).toHaveLength(1);
  await put(join(source, '.claude/skills/demo/.env'), 'TOKEN=hidden');
  await expect(readTransferPacket(resource)).rejects.toThrow(/credential file/);
  await rm(join(source, '.claude/skills/demo/.env'));
  await symlink('/etc/hosts', join(source, '.claude/skills/demo/link'));
  await expect(readTransferPacket(resource)).rejects.toThrow(/link/);
  await rm(join(source, '.claude/skills/demo/link'));
  await put(join(source, '.claude/skills/demo/SKILL.md'), 'Read ../_shared/notes.md\n');
  expect((await readTransferPacket(resource)).dependencies).toEqual([
    join(source, '.claude/skills/_shared/notes.md'),
  ]);
});
function memoryStore() {
  let saved: TransferState | null = null;
  const store: TransferStore = {
    load: async () => structuredClone(saved),
    save: async (s) => {
      saved = structuredClone(s);
    },
  };
  return store;
}
async function waitTask(
  service: ReturnType<typeof createTransferService>,
  id: string,
): Promise<TransferTask> {
  let t!: TransferTask;
  await vi.waitFor(async () => {
    t = (await service.overview()).tasks.find((t) => t.id === id)!;
    expect(t.state).not.toBe('running');
  });
  return t;
}
it('freezes reviewed resources, re-evaluates rules on repeat, and does not retry completed destinations', async () => {
  const catalog = await catalogFixture();
  const store = memoryStore();
  const transport = vi.fn(async (_device, request) => remote(request));
  const service = createTransferService({
    catalog,
    store,
    remote: transport,
    fingerprint: async () => 'trusted',
  });
  const device = await service.addDevice({
    name: 'test',
    host: 'fixture',
    username: 'user',
    port: 22,
  });
  const draft = await service.saveDraft({
    name: 'copy',
    selection: [{ scope: 'global', type: 'skill', include: true }],
    targets: [{ deviceId: device.id, projects: {} }],
  });
  const compared = await service.compare(draft.id);
  expect(compared.items[0].action).toBe('add');
  await put(join(source, '.claude/skills/new/SKILL.md'), '# Added after comparison\n');
  await service.run(draft.id, {});
  const completed = await waitTask(service, draft.id);
  expect(completed.state).toBe('complete');
  expect(completed.items).toHaveLength(1);
  const newService = createTransferService({
    catalog,
    store,
    remote: transport,
    fingerprint: async () => 'trusted',
  });
  expect((await newService.overview()).tasks[0].state).toBe('complete');
  catalog.startScan();
  await catalog.whenIdle();
  const repeated = await newService.repeat(draft.id);
  const fresh = await newService.compare(repeated.id);
  expect(fresh.items).toHaveLength(2);
  expect(fresh.items.find((i) => i.name === 'demo')?.reason).toBe('Identical');
});
it('blocks source changes after review and keeps errors for retry', async () => {
  const catalog = await catalogFixture();
  const service = createTransferService({
    catalog,
    store: memoryStore(),
    remote: async (_d, r) => remote(r as Record<string, unknown>),
    fingerprint: async () => 'trusted',
  });
  const d = await service.addDevice({ name: 'test', host: 'fixture', username: 'user', port: 22 });
  const t = await service.saveDraft({
    name: 'changed',
    selection: [{ include: true }],
    targets: [{ deviceId: d.id, projects: {} }],
  });
  await service.compare(t.id);
  await put(join(source, '.claude/skills/demo/SKILL.md'), '# Changed\n');
  await service.run(t.id, {});
  const result = await waitTask(service, t.id);
  expect(result.state).toBe('failed');
  expect(result.items[0].error).toMatch(/Source changed/);
  expect((await remote({ ...location(), op: 'inspect' })).hash).toBeNull();
});
it('adds dependencies to review, prevents skipped dependencies, then copies them first', async () => {
  const catalog = await catalogFixture();
  await put(join(source, '.claude/skills/demo/SKILL.md'), 'Read ../_shared/notes.md\n');
  await put(join(source, '.claude/skills/_shared/notes.md'), '# shared\n');
  catalog.startScan();
  await catalog.whenIdle();
  const applied: string[] = [];
  const service = createTransferService({
    catalog,
    store: memoryStore(),
    remote: async (_d, r) => {
      const req = r as Record<string, unknown>;
      if (req.op === 'apply') applied.push(String(req.relativePath));
      return remote(req);
    },
    fingerprint: async () => 'trusted',
  });
  const d = await service.addDevice({ name: 'test', host: 'fixture', username: 'user', port: 22 });
  const demo = catalog.getCatalog().resources.find((r) => r.name === 'demo')!;
  const t = await service.saveDraft({
    name: 'dependencies',
    selection: [{ resourceId: demo.id, include: true }],
    targets: [{ deviceId: d.id, projects: {} }],
  });
  await service.compare(t.id);
  expect(t.items).toHaveLength(2);
  const dependency = t.items.find((i) => i.name === '_shared')!;
  await expect(service.run(t.id, { [dependency.id]: 'skip' })).rejects.toThrow(
    /dependency is skipped/,
  );
  expect(dependency.action).toBe('add');
  await service.run(t.id, {});
  expect((await waitTask(service, t.id)).state).toBe('complete');
  expect(applied).toEqual(['skills/_shared', 'skills/demo']);
});

describe('transfer HTTP boundary', () => {
  async function start(local = true) {
    const app = express();
    const transport = vi.fn();
    app.use(
      '/api/resources',
      createResourceRouter({
        home: source,
        env: {},
        sessionProjectPaths: () => [],
        ...(local ? {} : { isLocalRequest: () => false }),
        transfers: { store: memoryStore(), remote: transport, fingerprint: async () => 'trusted' },
      }),
    );
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/resources/transfers`,
      transport,
    };
  }
  it('hides transfer reads and writes from remote clients', async () => {
    const { url, transport } = await start(false);
    expect((await fetch(url)).status).toBe(404);
    expect(
      (
        await fetch(url + '/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects cross-origin writes, form bodies and shell-shaped hosts before SSH', async () => {
    const { url, transport } = await start();
    const device = { name: 'x', host: 'server;touch /tmp/unsafe', username: 'user', port: 22 };
    expect(
      (
        await fetch(url + '/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(device),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url + '/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url + '/devices', { method: 'POST', body: 'x=1' })).status).toBe(415);
    expect(transport).not.toHaveBeenCalled();
  });
});

it('retries only a failed destination after a partial multi-device transfer', async () => {
  const catalog = await catalogFixture();
  const writes: string[] = [];
  let failSecond = true;
  const transport = async (d: { host: string }, raw: unknown) => {
    const req = raw as Record<string, unknown>;
    if (req.op === 'probe') return { home: '/home/test', platform: 'linux', node: '22.0.0' };
    if (req.op === 'inspect')
      return { hash: null, files: [], destinationPath: '/home/test/.claude/skills/demo' };
    writes.push(d.host);
    if (d.host === 'two' && failSecond) throw new Error('Connection interrupted');
    return { hash: req.sourceHash };
  };
  const service = createTransferService({
    catalog,
    store: memoryStore(),
    remote: transport,
    fingerprint: async () => 'trusted',
  });
  const a = await service.addDevice({ name: 'One', host: 'one', username: 'user', port: 22 });
  const b = await service.addDevice({ name: 'Two', host: 'two', username: 'user', port: 22 });
  const t = await service.saveDraft({
    name: 'multi',
    selection: [{ include: true }],
    targets: [
      { deviceId: a.id, projects: {} },
      { deviceId: b.id, projects: {} },
    ],
  });
  await service.compare(t.id);
  await service.run(t.id, {});
  expect((await waitTask(service, t.id)).state).toBe('partial');
  failSecond = false;
  await service.run(t.id, {});
  expect((await waitTask(service, t.id)).state).toBe('complete');
  expect(writes).toEqual(['one', 'two', 'two']);
});
it('cancels between items and records an in-flight copy before calling the remote writer', async () => {
  const catalog = await catalogFixture();
  await put(join(source, '.claude/skills/second/SKILL.md'), '# second\n');
  catalog.startScan();
  await catalog.whenIdle();
  let saved: TransferState | null = null;
  const store: TransferStore = {
    load: async () => saved,
    save: async (s) => {
      saved = structuredClone(s);
    },
  };
  let release: (value: Record<string, unknown>) => void = () => {};
  const writes: string[] = [];
  const service = createTransferService({
    catalog,
    store,
    fingerprint: async () => 'trusted',
    remote: async (_d, raw) => {
      const req = raw as Record<string, unknown>;
      if (req.op === 'probe') return { home: '/home/test', platform: 'linux', node: '22.0.0' };
      if (req.op === 'inspect')
        return { hash: null, files: [], destinationPath: '/home/test/.claude/' + req.relativePath };
      expect(saved?.tasks[0].items.some((i) => i.state === 'copying')).toBe(true);
      writes.push(String(req.relativePath));
      return new Promise((resolve) => {
        release = () => resolve({ hash: req.sourceHash });
      });
    },
  });
  const d = await service.addDevice({ name: 'test', host: 'one', username: 'user', port: 22 });
  const t = await service.saveDraft({
    name: 'cancel',
    selection: [{ include: true }],
    targets: [{ deviceId: d.id, projects: {} }],
  });
  await service.compare(t.id);
  await service.run(t.id, {});
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  await service.cancel(t.id);
  release({});
  await vi.waitFor(() =>
    expect(saved?.tasks[0].items.filter((i) => i.state === 'complete')).toHaveLength(1),
  );
  expect(writes).toHaveLength(1);
  expect((await service.overview()).tasks[0].state).toBe('cancelled');
  const persisted = structuredClone(saved!);
  persisted.tasks[0].state = 'running';
  const restarted = createTransferService({
    catalog,
    store: { load: async () => persisted, save: async () => {} },
    fingerprint: async () => 'trusted',
    remote: vi.fn(),
  });
  expect((await restarted.overview()).tasks[0].state).toBe('interrupted');
});
it('refuses changed host keys before applying a reviewed task', async () => {
  const catalog = await catalogFixture();
  let fingerprint = 'first';
  const transport = vi.fn(async (_d, raw) => {
    const r = raw as Record<string, unknown>;
    return r.op === 'probe'
      ? { home: '/home/test', platform: 'linux', node: '22.0.0' }
      : { hash: null, files: [], destinationPath: '/home/test/.claude/skills/demo' };
  });
  const service = createTransferService({
    catalog,
    store: memoryStore(),
    remote: transport,
    fingerprint: async () => fingerprint,
  });
  const d = await service.addDevice({ name: 'test', host: 'one', username: 'user', port: 22 });
  const t = await service.saveDraft({
    name: 'identity',
    selection: [{ include: true }],
    targets: [{ deviceId: d.id, projects: {} }],
  });
  await service.compare(t.id);
  fingerprint = 'changed';
  await service.run(t.id, {});
  const result = await waitTask(service, t.id);
  expect(result.state).toBe('failed');
  expect(result.items[0].error).toMatch(/host keys changed/);
  expect(transport.mock.calls.some(([, r]) => (r as Record<string, unknown>).op === 'apply')).toBe(
    false,
  );
});

it('refuses credential paths in a destination package before returning its text', async () => {
  await put(join(home, '.claude/skills/demo/.env'), 'TOKEN=do-not-export');
  await expect(remote({ ...location(), op: 'inspect' })).rejects.toThrow(/credential path/);
  await expect(remote(apply())).rejects.toThrow(/credential path/);
  expect(await readFile(join(home, '.claude/skills/demo/.env'), 'utf8')).toBe(
    'TOKEN=do-not-export',
  );
});
