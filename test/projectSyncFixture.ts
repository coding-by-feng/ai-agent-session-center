/**
 * Project Sync service tests: two temporary homes (this computer, the "server"), a saved
 * server whose helper runs locally, and the steps a test repeats. Both helpers are real.
 */
import { afterEach, beforeEach, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { localLauncher } from '../server/projectSync/helperClient.js';
import {
  createSyncService,
  type SyncService,
  type SyncServiceDeps,
} from '../server/projectSync/service.js';
import { memoryStore, type SyncStore } from '../server/projectSync/store.js';
import type { SyncDevice, SyncRun } from '../src/types/projectSync.js';

export interface SyncFixture {
  base: string;
  localHome: string;
  deviceHome: string;
  /** The project on this computer, and its folder on the server. */
  src: string;
  dst: string;
  device: SyncDevice;
  store: SyncStore;
  /** Project paths of AASC sessions working right now. */
  active: string[];
}

/** Fresh homes, project, server and store before each test; all removed after it. */
export function useSyncFixture(): SyncFixture {
  const f = {} as SyncFixture;
  beforeEach(async () => {
    f.base = await realpath(await mkdtemp(join(tmpdir(), 'aasc-sync-service-')));
    f.localHome = join(f.base, 'local-home');
    f.deviceHome = join(f.base, 'device-home');
    f.src = join(f.localHome, 'proj');
    f.dst = join(f.deviceHome, 'proj');
    await mkdir(f.src, { recursive: true });
    await mkdir(f.deviceHome, { recursive: true });
    f.device = {
      id: randomUUID(),
      name: 'mini',
      host: 'mini.local',
      username: 'me',
      port: 22,
      fingerprint: 'SHA256:pinned',
      home: f.deviceHome,
      platform: process.platform,
      checkedAt: 0,
    };
    f.store = memoryStore();
    f.active = [];
  });
  afterEach(async () => {
    await rm(f.base, { recursive: true, force: true });
  });
  return f;
}

export const catalogOf = (f: SyncFixture, extra: object[] = []) => ({
  getCatalog: () =>
    ({
      state: 'ready',
      projects: [
        { id: 'proj-1', name: 'proj', path: '~/proj', exists: true, evidence: [], counts: {} },
        { id: 'home', name: '~', path: '~', exists: true, isHome: true, evidence: [], counts: {} },
        ...extra,
      ],
    }) as never,
});

export function serviceOf(f: SyncFixture, overrides: Partial<SyncServiceDeps> = {}): SyncService {
  return createSyncService({
    catalog: catalogOf(f),
    home: f.localHome,
    store: f.store,
    devices: async () => [f.device],
    fingerprint: async () => 'SHA256:pinned',
    launchLocal: localLauncher({ ...process.env, HOME: f.localHome }),
    launchDevice: () => localLauncher({ ...process.env, HOME: f.deviceHome }),
    activeSessionPaths: () => f.active,
    saveEveryMs: 0,
    ...overrides,
  });
}

export async function put(p: string, body = 'x\n') {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
}

export async function settle(s: SyncService, id: string): Promise<SyncRun> {
  for (let i = 0; i < 400; i++) {
    const r = await s.getRun(id);
    if (r.state !== 'comparing' && r.state !== 'running') return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('run did not settle');
}

export async function compare(s: SyncService, linkId: string) {
  return settle(s, (await s.compare(linkId)).id);
}

export async function runIt(s: SyncService, runId: string, confirm = false) {
  await s.run(runId, { confirmLiveSessions: confirm });
  return settle(s, runId);
}

export async function sync(s: SyncService, linkId: string) {
  const r = await compare(s, linkId);
  expect(r.state).toBe('review');
  return runIt(s, r.id);
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
