// Oct 29 2026: RESOURCES → Projects lists every project folder on this Mac, GitHub or not, most
// used first (the /known-projects rule), reads each saved checkout's Git state past a live agent,
// and checks saved projects by itself when it opens: a fetch made in the last 10 minutes is skipped.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { projectFixture } from './cloudProjectsFixture.js';
import { sqliteIt } from './helpers/nativeSqlite.js';
import { rankFolders } from '../server/cloud/projectFolders.js';
import type { ProjectActivity } from '../server/knownProjects.js';

const origin = {
  url: 'https://github.com/fixture/repo',
  owner: 'fixture',
  name: 'repo',
  branch: 'main',
};
const other = { url: 'https://github.com/fixture/other', owner: 'fixture', name: 'other', branch: 'dev' };
afterEach(() => {
  vi.useRealTimers();
});

it('rankFolders: sessions in the last 30 days first, then latest activity, then path', () => {
  const folder = (path: string) => ({ path, repository: null, projectId: null });
  const ranked = rankFolders(
    [folder('/h/a'), folder('/h/b'), folder('/h/c'), folder('/h/d')],
    [
      { project_path: '/h/c', recent: 3, last: 100 },
      { project_path: '/h/b', recent: 0, last: 900 },
      { project_path: '/h/d', recent: 3, last: 200 },
      { project_path: '/elsewhere', recent: 9, last: 999 },
    ],
  );
  expect(ranked.map((f) => [f.path, f.recent, f.lastActivityAt])).toEqual([
    ['/h/d', 3, 200],
    ['/h/c', 3, 100],
    ['/h/b', 0, 900],
    ['/h/a', 0, null],
  ]);
});

it('rankFolders turns a malformed activity row into "no activity", never a bad number', () => {
  const ranked = rankFolders(
    [{ path: '/h/a', repository: null, projectId: null }],
    [{ project_path: '/h/a', recent: Number.NaN, last: 'soon' as unknown as number }],
  );
  expect(ranked[0]).toMatchObject({ recent: 0, lastActivityAt: null });
});

async function withFolders() {
  let paths: string[] = [];
  let activity: ProjectActivity[] = [];
  const f = await projectFixture(undefined, {
    candidatePaths: () => paths,
    projectActivity: () => activity,
  });
  const repo = join(f.home, 'code', 'repo'),
    notes = join(f.home, 'notes'),
    otherRepo = join(f.home, 'code', 'other');
  for (const p of [repo, notes, otherRepo]) await mkdir(p, { recursive: true });
  paths = [notes, repo, otherRepo, '/outside/home', join(f.home, 'gone')];
  activity = [
    { project_path: repo, recent: 4, last: 50 },
    { project_path: notes, recent: 1, last: 70 },
  ];
  f.git.readOrigin.mockImplementation(async (p: string) =>
    p === repo ? origin : p === otherRepo ? other : null,
  );
  return { ...f, repo, notes, otherRepo };
}

sqliteIt('lists every catalog folder, GitHub or not, with its saved project, most used first', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding); // the cloud has fixture/repo on main
  const answer = await f.service.folders(f.binding);
  // The home folder comes along, so the tab can write ~/code/repo.
  expect(answer.home).toBe(f.home);
  expect(answer.items).toEqual([
    {
      path: f.repo,
      repository: { provider: 'github', ...origin },
      projectId: f.project.id,
      recent: 4,
      lastActivityAt: 50,
    },
    { path: f.notes, repository: null, projectId: null, recent: 1, lastActivityAt: 70 },
    {
      path: f.otherRepo,
      repository: { provider: 'github', ...other },
      projectId: null,
      recent: 0,
      lastActivityAt: null,
    },
  ]);
  // Saving still offers only the GitHub folders.
  expect((await f.service.candidates(f.binding)).items.map((c) => c.path)).toEqual([
    f.otherRepo,
    f.repo,
  ]);
});

sqliteIt('lists the folders without a connection too, matched to no saved project', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding); // a saved record is cached for the account…
  const answer = await f.service.folders(null);
  // …but with no connection to name the account, no folder is matched to it.
  expect(answer.home).toBe(f.home);
  expect(answer.items.map((i) => [i.path, i.projectId])).toEqual([
    [f.repo, null],
    [f.notes, null],
    [f.otherRepo, null],
  ]);
  expect(answer.items[0]?.repository).toEqual({ provider: 'github', ...origin });
});

sqliteIt('a saved checkout reads its Git state past a live agent and says one is there', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding);
  f.git.agentActive.mockImplementation((root: string) => root === f.repo);
  const local = await f.service.localProject(f.project.id, f.binding);
  expect(local).toMatchObject({ state: 'ready', path: f.repo, agentActive: true });
  expect(f.git.inspectCheckout).toHaveBeenLastCalledWith(f.repo, expect.anything(), {
    ignoreAgents: true,
  });
});

sqliteIt('an automatic Check skips a project fetched in the last 10 minutes; Check now always fetches', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  await f.service.checkProject(f.project.id, f.binding, { auto: true });
  expect(f.git.fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-10-29T10:09:00Z'));
  expect(await f.service.checkProject(f.project.id, f.binding, { auto: true })).toMatchObject({
    state: 'ready',
    path: f.repo,
  });
  expect(f.git.fetch).toHaveBeenCalledTimes(1);
  await f.service.checkProject(f.project.id, f.binding);
  expect(f.git.fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2026-10-29T10:20:00Z'));
  await f.service.checkProject(f.project.id, f.binding, { auto: true });
  expect(f.git.fetch).toHaveBeenCalledTimes(3);
});

// Security review, Oct 29 2026: an automatic Check never uses an SSH key (one that asks, a security
// key or a confirming agent, would ask on every visit), and a failed one is not retried on every
// visit either.
sqliteIt('an automatic Check leaves an SSH checkout alone; Check now fetches it', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding);
  f.git.sshTransport.mockImplementation(async (root: string) => root === f.repo);
  expect(await f.service.checkProject(f.project.id, f.binding, { auto: true })).toMatchObject({
    state: 'ready',
    path: f.repo,
  });
  expect(f.git.fetch).not.toHaveBeenCalled();
  await f.service.checkProject(f.project.id, f.binding);
  expect(f.git.fetch).toHaveBeenCalledTimes(1);
});

sqliteIt('a failed automatic Check waits out the 10 minutes like a good one', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  f.git.fetch.mockRejectedValueOnce(new Error('network down'));
  await expect(f.service.checkProject(f.project.id, f.binding, { auto: true })).rejects.toThrow();
  vi.setSystemTime(new Date('2026-10-29T10:05:00Z'));
  await f.service.checkProject(f.project.id, f.binding, { auto: true });
  expect(f.git.fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-10-29T10:11:00Z'));
  await f.service.checkProject(f.project.id, f.binding, { auto: true });
  expect(f.git.fetch).toHaveBeenCalledTimes(2);
});

sqliteIt('an automatic Check reads the saved record here, not the cloud list', async () => {
  const f = await withFolders();
  await f.service.listProjects({}, f.binding);
  const request = vi.mocked(f.cloud.client.request);
  request.mockClear();
  await f.service.checkProject(f.project.id, f.binding, { auto: true });
  expect(f.git.fetch).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});

sqliteIt('with no connection, folder lists within 30 seconds share one scan', async () => {
  const f = await withFolders();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
  await Promise.all([f.service.folders(null), f.service.folders(null)]);
  await f.service.folders(null);
  const once = f.git.readOrigin.mock.calls.length;
  expect(once).toBeGreaterThan(0);
  vi.setSystemTime(new Date('2026-10-29T10:00:31Z'));
  await f.service.folders(null);
  expect(f.git.readOrigin.mock.calls.length).toBe(once * 2);
});

// Code review, Oct 29 2026: the folders list carries why a GitHub checkout can't be read.
sqliteIt('a checkout AASC will not read lists with the reason, and no repository', async () => {
  const f = await withFolders();
  f.git.readOrigin.mockImplementation(async (p: string) =>
    p === f.repo ? { blocked: 'settings' as const } : null,
  );
  const answer = await f.service.folders(f.binding);
  expect(answer.items.find((i) => i.path === f.repo)).toMatchObject({
    repository: null,
    projectId: null,
    blocked: 'settings',
  });
  expect(answer.items.find((i) => i.path === f.notes)).not.toHaveProperty('blocked');
  expect((await f.service.candidates(f.binding)).items).toEqual([]);
});
