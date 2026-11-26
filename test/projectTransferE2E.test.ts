/**
 * Copy / Move a project end to end: two real servers (source and target, each with its own home
 * folder) and Electron main's transfer client between them, over real HTTP on loopback.
 */
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectDirName } from '../server/projectTransfer/paths.js';
import { createReceiver } from '../server/projectTransfer/receiver.js';
import { createAllowList, createMovedLog } from '../server/projectTransfer/records.js';
import { createProjectTransferRouter } from '../server/projectTransfer/router.js';
import { createSender, type ExportedAascData } from '../server/projectTransfer/sender.js';
import {
  createTransferClient, TransferFailed, type StreamFetch, type TransferDeps,
} from '../electron/remote/projectTransfer.js';
import type { TransferMode, TransferOptions, TransferPlanInfo, TransferProgress } from '../src/types/projectTransfer.js';

const OPTIONS: TransferOptions = { memory: true, aasc: false, includeNodeModules: false };
const COMPUTER = { id: 'computer-a', label: 'Mac A' };

interface Side {
  home: string;
  data: string;
  server: Server;
  origin: string;
}

let source: Side;
let target: Side;
let root: string;
let secure: boolean;
let working: string[];
let exportAasc: ((root: string) => ExportedAascData) | undefined;
let imported: { raw: unknown; mediaDir: string; media: string[] }[];

async function listen(app: express.Express): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

async function makeSide(role: 'source' | 'target'): Promise<Side> {
  const home = await realpath(await mkdtemp(join(tmpdir(), `pt-${role}-`)));
  const data = join(home, 'aasc-data');
  const allowList = createAllowList(data);
  const receiver = createReceiver({
    home, env: {},
    isAllowed: (id) => allowList.isAllowed(id),
    allow: (id, label) => allowList.allow(id, label),
    onRequestsChanged: () => undefined,
    importAasc: (raw, opts) => {
      const mediaFile = join(opts.mediaDir, 'media', 's1', 'm1.png');
      imported.push({ raw, mediaDir: opts.mediaDir, media: existsSync(mediaFile) ? [readFileSync(mediaFile, 'utf8')] : [] });
      return { sessions: 1, prompts: 2, notes: 0, media: 1, queues: 0 };
    },
    freeBytes: async () => 10 * 1024 ** 3,
  });
  const sender = createSender({
    home, env: {}, workingPaths: () => working,
    exportAasc: (r) => {
      if (!exportAasc) throw new Error('no export');
      return exportAasc(r);
    },
    tmpRoot: home,
  });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/project-transfer', createProjectTransferRouter({
    sender, receiver, moved: createMovedLog(data),
    isLocal: () => true,
    computerOf: (req) => (req.headers.authorization === 'Bearer good-token-1234567890' ? COMPUTER : null),
    secureChannel: () => secure,
  }));
  const { server, origin } = await listen(app);
  return { home, data, server, origin };
}

async function seedProject(): Promise<void> {
  root = join(source.home, 'Documents', 'proj');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n');
  await writeFile(join(root, '.env'), 'TOKEN=abc\n', { mode: 0o644 });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  await symlink('src/a.ts', join(root, 'link-to-a'));
  const claude = join(source.home, '.claude', 'projects', claudeProjectDirName(root));
  await mkdir(join(claude, 'memory'), { recursive: true });
  await writeFile(join(claude, 'memory', 'MEMORY.md'), '- remember this\n');
  await writeFile(join(claude, 'sess.jsonl'), `${JSON.stringify({ type: 'user', cwd: root })}\n${JSON.stringify({ type: 'x', cwd: join(root, 'src') })}\n`);
  const day = join(source.home, '.codex', 'sessions', '2026', '11', '22');
  await mkdir(day, { recursive: true });
  await writeFile(join(day, 'rollout-2026-11-22T10-00-00-abc.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: root } })}\n`);
}

async function plan(options: TransferOptions = OPTIONS): Promise<TransferPlanInfo> {
  const res = await fetch(`${source.origin}/api/project-transfer/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, options }),
  });
  const body = (await res.json()) as { success: boolean; data: TransferPlanInfo; error?: string };
  if (!body.success) throw new Error(body.error);
  return body.data;
}

async function allowSourceComputer(): Promise<void> {
  createAllowList(target.data).allow(COMPUTER.id, COMPUTER.label);
}

interface RunOptions {
  planId: string;
  transferId?: string;
  mode?: TransferMode;
  destination?: string;
  fetch?: StreamFetch;
  onSleep?: () => Promise<void>;
  signal?: AbortSignal;
}

function runTransfer(o: RunOptions) {
  const progress: TransferProgress[] = [];
  const trashed: string[] = [];
  const deps: TransferDeps = {
    fetch: o.fetch ?? ((url, init) => fetch(url, init as RequestInit)),
    trash: async (p) => {
      trashed.push(p);
      await rm(p, { recursive: true, force: true });
    },
    exists: (p) => stat(p).then(() => true, () => false),
    sleep: async () => {
      await o.onSleep?.();
    },
    now: () => Date.now(),
  };
  const client = createTransferClient(deps, {
    transferId: o.transferId ?? crypto.randomUUID(),
    local: { origin: source.origin, sessionToken: null },
    remote: { origin: target.origin, token: 'good-token-1234567890', name: 'Mac B' },
    planId: o.planId,
    destination: o.destination ?? '~/Work/proj',
    mode: o.mode ?? 'copy',
    signal: o.signal ?? new AbortController().signal,
    onProgress: (p) => progress.push(p),
  });
  return { promise: client.runAll(), progress, trashed };
}

const dest = (): string => join(target.home, 'Work', 'proj');

beforeEach(async () => {
  secure = true;
  working = [];
  exportAasc = undefined;
  imported = [];
  source = await makeSide('source');
  target = await makeSide('target');
  await seedProject();
});

afterEach(async () => {
  for (const side of [source, target]) {
    await new Promise<void>((resolve) => side.server.close(() => resolve()));
    await rm(side.home, { recursive: true, force: true });
  }
});

describe('Copy to computer', () => {
  it('copies the folder, re-keys Claude and Codex memory, and leaves no stage', async () => {
    await allowSourceComputer();
    const info = await plan();
    expect(info.homeRelative).toBe('Documents/proj');
    expect(info.summary.byGroup.claude.files).toBe(2);
    expect(info.summary.byGroup.codex.files).toBe(1);

    const { promise, progress } = runTransfer({ planId: info.planId });
    const outcome = await promise;
    expect(outcome.commit).toMatchObject({ destination: '~/Work/proj', claudeFiles: 2, codexFiles: 1, skippedExisting: 0, warnings: [] });
    expect(progress.map((p) => p.stage)).toEqual(expect.arrayContaining(['connecting', 'sending', 'committing', 'done']));

    expect(await readFile(join(dest(), 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n');
    expect((await stat(join(dest(), '.env'))).mode & 0o777).toBe(0o600);
    expect(await readlink(join(dest(), 'link-to-a'))).toBe('src/a.ts');
    expect((await stat(join(dest(), 'empty'))).isDirectory()).toBe(true);
    await expect(lstat(join(dest(), '.git', 'hooks', 'pre-commit'))).rejects.toThrow();
    expect(await readFile(join(dest(), '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');

    const claude = join(target.home, '.claude', 'projects', claudeProjectDirName(dest()));
    expect(await readFile(join(claude, 'memory', 'MEMORY.md'), 'utf8')).toBe('- remember this\n');
    const lines = (await readFile(join(claude, 'sess.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.cwd)).toEqual([dest(), join(dest(), 'src')]);
    const rollout = await readFile(join(target.home, '.codex', 'sessions', '2026', '11', '22', 'rollout-2026-11-22T10-00-00-abc.jsonl'), 'utf8');
    expect(JSON.parse(rollout.trim()).payload.cwd).toBe(dest());

    expect((await readdir(join(target.home, 'Work'))).filter((n) => n.startsWith('.aasc-transfer-'))).toEqual([]);
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n'); // Copy leaves the source
  });

  it('waits for Allow once, then remembers the computer', async () => {
    const info = await plan();
    let answered = 0;
    const first = runTransfer({
      planId: info.planId,
      onSleep: async () => {
        const reqs = (await (await fetch(`${target.origin}/api/project-transfer/requests`)).json()) as { data: { id: string; computerLabel: string }[] };
        if (reqs.data.length && answered === 0) {
          answered++;
          // Nothing is written for a computer not yet allowed.
          await expect(stat(join(target.home, 'Work'))).rejects.toThrow();
          expect(reqs.data[0].computerLabel).toBe('Mac A');
          await fetch(`${target.origin}/api/project-transfer/requests/${reqs.data[0].id}/allow`, { method: 'POST' });
        }
      },
    });
    await first.promise;
    expect(first.progress.some((p) => p.stage === 'waiting-allow')).toBe(true);

    await rm(dest(), { recursive: true, force: true });
    const second = runTransfer({ planId: (await plan()).planId });
    await second.promise;
    expect(second.progress.some((p) => p.stage === 'waiting-allow')).toBe(false);
  });

  it('stops when the target declines, and keeps nothing there', async () => {
    const info = await plan();
    const run = runTransfer({
      planId: info.planId,
      onSleep: async () => {
        const reqs = (await (await fetch(`${target.origin}/api/project-transfer/requests`)).json()) as { data: { id: string }[] };
        if (reqs.data[0]) await fetch(`${target.origin}/api/project-transfer/requests/${reqs.data[0].id}/decline`, { method: 'POST' });
      },
    });
    await expect(run.promise).rejects.toMatchObject({ code: 'declined', resumable: false });
    expect((await readdir(join(target.home, 'Work')).catch(() => [])).length).toBe(0);
  });

  it('refuses a destination that already exists and points to Project Sync', async () => {
    await allowSourceComputer();
    await mkdir(dest(), { recursive: true });
    await writeFile(join(dest(), 'keep.txt'), 'mine');
    const run = runTransfer({ planId: (await plan()).planId });
    const err = (await run.promise.catch((e: unknown) => e)) as TransferFailed;
    expect(err).toBeInstanceOf(TransferFailed);
    expect(err.code).toBe('destination_exists');
    expect(err.resumable).toBe(false);
    expect(err.message).toMatch(/Project Sync/);
    expect(await readFile(join(dest(), 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('is refused over anything but Tailscale or HTTPS, and to anyone but a paired computer', async () => {
    await allowSourceComputer();
    secure = false;
    await expect(runTransfer({ planId: (await plan()).planId }).promise).rejects.toMatchObject({ code: 'insecure_channel', resumable: false });
    secure = true;
    const res = await fetch(`${target.origin}/api/project-transfer/incoming`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer someone-else' }, body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('computer_only');
  });

  it('refuses a plan that writes outside the project or into git hooks', async () => {
    await allowSourceComputer();
    const post = (items: unknown[]) => fetch(`${target.origin}/api/project-transfer/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token-1234567890' },
      body: JSON.stringify({ id: crypto.randomUUID(), projectName: 'x', destination: '~/Work/x', sourceRoot: '/a/x', items }),
    });
    const file = (rel: string, group = 'project') => ({ i: 0, group, rel, kind: 'file', size: 1, mode: 0o644, sha256: 'a'.repeat(64) });
    for (const items of [[file('../escape')], [file('.git/hooks/post-checkout')], [file('../../x.jsonl', 'claude')]]) {
      const res = await post(items);
      expect(res.status).toBe(400);
    }
    const traversal = await fetch(`${target.origin}/api/project-transfer/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token-1234567890' },
      body: JSON.stringify({ id: crypto.randomUUID(), projectName: 'x', destination: '~/../etc', sourceRoot: '/a/x', items: [] }),
    });
    expect(traversal.status).toBe(400);
  });

  it('never makes folders through a link in the target’s home', async () => {
    await allowSourceComputer();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pt-outside-')));
    try {
      await symlink(outside, join(target.home, 'Work'));
      const run = runTransfer({ planId: (await plan()).planId, destination: '~/Work/sub/proj' });
      const err = (await run.promise.catch((e: unknown) => e)) as TransferFailed;
      expect(err.code).toBe('path_not_allowed');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resumes an interrupted transfer, sending only what is missing', async () => {
    await allowSourceComputer();
    for (let n = 0; n < 2_100; n++) await writeFile(join(root, 'src', `f${n}.txt`), `file ${n}\n`);
    const info = await plan();
    const transferId = crypto.randomUUID();
    let puts = 0;
    const flaky: StreamFetch = async (url, init) => {
      if (init.method === 'PUT' && ++puts === 2) throw new Error('network down');
      return fetch(url, init as RequestInit);
    };
    const err = (await runTransfer({ planId: info.planId, transferId, fetch: flaky }).promise.catch((e: unknown) => e)) as TransferFailed;
    expect(err.code).toBe('offline');
    expect(err.resumable).toBe(true);

    const sentRanges: string[] = [];
    const watching: StreamFetch = async (url, init) => {
      if (init.method === 'PUT') sentRanges.push(new URL(url).searchParams.get('items') ?? '');
      return fetch(url, init as RequestInit);
    };
    const resumed = runTransfer({ planId: info.planId, transferId, fetch: watching });
    const outcome = await resumed.promise;
    expect(outcome.commit.files).toBeGreaterThan(2_100);
    expect(sentRanges).toHaveLength(1); // the first pack (2,000 files) arrived before the break
    expect(await readFile(join(dest(), 'src', 'f2099.txt'), 'utf8')).toBe('file 2099\n');
  });

  it('measures again when a file changes while being sent, and lands the new bytes', async () => {
    await allowSourceComputer();
    const info = await plan();
    let changed = false;
    const changing: StreamFetch = async (url, init) => {
      if (!changed && url.includes('/pack?')) {
        changed = true;
        await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2 // edited mid-copy\n');
      }
      return fetch(url, init as RequestInit);
    };
    await runTransfer({ planId: info.planId, fetch: changing }).promise;
    expect(await readFile(join(dest(), 'src', 'a.ts'), 'utf8')).toBe('export const a = 2 // edited mid-copy\n');
  });

  it('carries the AASC bundle and its media to the target’s import', async () => {
    await allowSourceComputer();
    const media = join(source.home, 'media-src.png');
    await writeFile(media, 'PNGDATA');
    exportAasc = () => ({
      bundle: { version: 1, sessions: [{ id: 's1' }] },
      media: [{ rel: 'media/s1/m1.png', abs: media, size: 7 }],
      counts: { sessions: 1, prompts: 2, notes: 0, media: 1, queues: 0 },
    });
    const info = await plan({ ...OPTIONS, aasc: true });
    expect(info.summary.aasc?.sessions).toBe(1);
    imported = [];
    const outcome = await runTransfer({ planId: info.planId }).promise;
    expect(outcome.commit.aasc).toEqual({ sessions: 1, prompts: 2, notes: 0, media: 1, queues: 0 });
    expect(imported).toHaveLength(1);
    expect(imported[0].raw).toEqual({ version: 1, sessions: [{ id: 's1' }] });
    expect(imported[0].media).toEqual(['PNGDATA']);
  });
});

describe('Move to computer', () => {
  it('trashes the folder and its Claude memory after the copy, and leaves a marker', async () => {
    await allowSourceComputer();
    const info = await plan();
    const run = runTransfer({ planId: info.planId, mode: 'move' });
    const outcome = await run.promise;
    expect(outcome.moved).toBe(true);
    expect(run.trashed).toEqual([root, join(source.home, '.claude', 'projects', claudeProjectDirName(root))]);
    await expect(stat(root)).rejects.toThrow();
    expect(await readFile(join(dest(), 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n');
    const moved = (await (await fetch(`${source.origin}/api/project-transfer/moved`)).json()) as { data: { root: string; computer: string; destination: string }[] };
    expect(moved.data[0]).toMatchObject({ root, computer: 'Mac B', destination: '~/Work/proj' });
  });

  it('keeps the folder when an agent is working in it, after a complete copy', async () => {
    await allowSourceComputer();
    const info = await plan();
    working = [join(root, 'src')];
    const run = runTransfer({ planId: info.planId, mode: 'move' });
    const outcome = await run.promise;
    expect(outcome.moved).toBe(false);
    expect(outcome.moveMessage).toMatch(/working in this folder/);
    expect(run.trashed).toEqual([]);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect((await stat(dest())).isDirectory()).toBe(true);
  });
});
