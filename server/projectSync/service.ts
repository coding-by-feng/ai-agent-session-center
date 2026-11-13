/**
 * Project Sync service: servers, links, compare → frozen plan → review → run, undo, and the base.
 * One compare/run/undo at a time; the run itself is runner.ts. Design: docs/plans/project-sync-design.md.
 */
import { randomUUID } from 'crypto';
import { lstat, realpath } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import type { ResourceCatalogService } from '../resourceCatalog.js';
import { isWithin } from '../fsSafe.js';
import log from '../logger.js';
import { knownFingerprint, nodeEvalCommand, spawnPinnedSsh } from './transport.js';
import { classify } from './classify.js';
import { applyDecisions, type DecisionRequest } from './decisions.js';
import { clean, SyncError } from './errors.js';
import { localLauncher, probe, readManifest, type Launcher } from './helperClient.js';
import { previewDiff } from './preview.js';
import { PROJECT_HELPER } from './projectHelper.js';
import { createPulls } from './pullPaths.js';
import { browseFolder, defaultSpaceOf, ensureRoom, purgeJournals } from './remoteFolders.js';
import { executeRun, undoRunSides } from './runner.js';
import { checkNewDevice, measureFold, validRemoteRoot } from './servers.js';
import { sqliteStore, type StoredLink, type SyncStore } from './store.js';
import { localWinsWarning, massDeleteAsk, summarize, warningsFor } from './summary.js';
import {
  isActing,
  keepBothPath,
  type FileMeta,
  type SyncDevice,
  type SyncConflictPolicy,
  type SyncDeviceInput,
  type SyncDirection,
  type SyncEntry,
  type SyncEntryFilter,
  type SyncEntryPage,
  type SyncLink,
  type SyncLinkInput,
  type SyncOverview,
  type SyncPullInput,
  type SyncRun,
} from '../../src/types/projectSync.js';

export { SyncError } from './errors.js';

export interface SyncServiceDeps {
  catalog: Pick<ResourceCatalogService, 'getCatalog'>;
  home?: string;
  store?: SyncStore | Promise<SyncStore>;
  /** Saved servers. Default: the store's. */
  devices?: () => Promise<SyncDevice[]>;
  fingerprint?: (d: SyncDeviceInput) => Promise<string>;
  launchLocal?: Launcher;
  launchDevice?: (d: SyncDeviceInput & { fingerprint: string }) => Launcher;
  /**
   * How this machine's file system folds names under `root` (letter case, Unicode
   * normalization), or undefined when it keeps them apart. Default: measured on disk.
   */
  foldLocal?: (root: string) => Promise<((path: string) => string) | undefined>;
  /** Absolute project paths of AASC sessions that are busy right now (working/prompting/approval/input). */
  activeSessionPaths?: () => string[];
  localPlatform?: string;
  /** Persist progress at most this often while a run is going (ms). */
  saveEveryMs?: number;
  /** Free bytes where a side writes (null: unknown). Default: asks that side's helper. */
  freeSpace?: (launch: Launcher, path: string) => Promise<number | null>;
  /** A run's undo journal younger than this survives a purge (default: one hour). */
  journalMinAgeMs?: number;
}

const RUNS_KEPT_PER_LINK = 10;
const ACTIVE_RUN: ReadonlySet<SyncRun['state']> = new Set(['comparing', 'running']);
/** States a planned run can start (or retry) from. A compare that failed has no plan. */
const RUNNABLE: ReadonlySet<SyncRun['state']> = new Set([
  'review',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

/** A link's conflict policy; links made before it existed ask. */
const policyOf = (l: StoredLink): SyncConflictPolicy => l.conflictPolicy ?? 'ask';

/** `~/x` (catalog display path) → absolute. */
function expand(display: string, home: string): string {
  if (display === '~') return home;
  return display.startsWith('~/') ? join(home, display.slice(2)) : display;
}

const strip = (m: FileMeta | undefined): FileMeta | undefined => {
  if (!m) return m;
  const { sha256: _hidden, ...rest } = m;
  return rest;
};
/** What the browser sees: credential hashes never leave the server. */
function publicEntry(e: SyncEntry): SyncEntry {
  if (!e.flags.includes('credential')) return e;
  return { ...e, local: strip(e.local), device: strip(e.device), base: strip(e.base) };
}

export function createSyncService(deps: SyncServiceDeps) {
  const home = deps.home ?? homedir();
  const devicesOf = deps.devices ?? (async () => (await load(), store.loadDevices()));
  const fingerprint = deps.fingerprint ?? knownFingerprint;
  const launchLocal = deps.launchLocal ?? localLauncher();
  const launchDevice =
    deps.launchDevice ??
    ((d: SyncDeviceInput & { fingerprint: string }): Launcher =>
      () =>
        spawnPinnedSsh(d, nodeEvalCommand(PROJECT_HELPER)));
  const foldLocal = deps.foldLocal ?? measureFold;
  const localPlatform = deps.localPlatform ?? process.platform;
  const saveEveryMs = deps.saveEveryMs ?? 1000;
  const spaceOf = deps.freeSpace ?? defaultSpaceOf;

  let store: SyncStore;
  let links: StoredLink[] = [];
  let runs: SyncRun[] = [];
  const entryCache = new Map<string, SyncEntry[]>();
  let working: string | null = null;
  const cancelled = new Set<string>();
  let loaded: Promise<void> | undefined;

  const load = () =>
    (loaded ??= (async () => {
      store = await (deps.store ?? sqliteStore());
      links = await store.loadLinks();
      runs = await store.loadRuns();
      for (const r of runs)
        if (ACTIVE_RUN.has(r.state)) {
          r.error =
            r.state === 'comparing'
              ? 'Interrupted while comparing. Compare again.'
              : 'AASC stopped during the run. Retry continues where it stopped.';
          r.state = r.state === 'comparing' ? 'failed' : 'interrupted';
          await store.saveRun(r);
        }
    })());

  const link = (id: string) => {
    const l = links.find((x) => x.id === id);
    if (!l) throw new SyncError('Project link not found.', 404);
    return l;
  };
  const run = (id: string) => {
    const r = runs.find((x) => x.id === id);
    if (!r) throw new SyncError('Run not found.', 404);
    return r;
  };
  const deviceOf = async (id: string) => {
    const d = (await devicesOf()).find((x) => x.id === id);
    if (!d) throw new SyncError('Server not found. Add it again.');
    return d;
  };
  const check = async (d: SyncDevice) => {
    if ((await fingerprint(d)) !== d.fingerprint)
      throw new SyncError(
        'Trusted host keys changed. Verify the server in your terminal, then add it again.',
      );
  };
  const entriesOf = async (runId: string) => {
    let list = entryCache.get(runId);
    if (!list) {
      list = (await store.loadEntries(runId)).sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      entryCache.set(runId, list);
      for (const key of [...entryCache.keys()])
        if (entryCache.size > 3 && key !== runId && key !== working) entryCache.delete(key);
    }
    return list;
  };
  const busyGuard = () => {
    if (working)
      throw new SyncError(
        'Another compare, run or undo is in progress. Try again when it finishes.',
      );
  };

  function linkState(l: StoredLink): SyncLink['state'] {
    const last = l.lastRunId ? runs.find((r) => r.id === l.lastRunId) : undefined;
    if (!last) return 'never';
    if (ACTIVE_RUN.has(last.state)) return 'running';
    if (last.state === 'complete') return last.failed ? 'attention' : 'in-sync';
    if (last.state === 'partial' || last.state === 'failed' || last.state === 'interrupted')
      return 'attention';
    // Undone: both sides are back and the base is gone, as before a first compare.
    if (last.state === 'undone') return 'never';
    return 'pending';
  }
  const publicLink = (l: StoredLink): SyncLink => {
    const { localRoot: _private, ...rest } = l;
    return { ...rest, state: linkState(l) };
  };
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  async function saveRunAndLink(r: SyncRun) {
    r.updatedAt = Date.now();
    await store.saveRun(r);
  }

  /** Keeps a link's newest runs; the undo journals of the rest go too. */
  async function pruneRuns(l: StoredLink, d: SyncDevice) {
    const mine = runs.filter((r) => r.linkId === l.id).sort((a, b) => b.createdAt - a.createdAt);
    const old = mine.slice(RUNS_KEPT_PER_LINK);
    for (const o of old) {
      runs = runs.filter((r) => r.id !== o.id);
      entryCache.delete(o.id);
      await store.deleteRun(o.id);
    }
    if (old.length)
      await purgeJournals(
        [{ launch: launchDevice(d) }, { launch: launchLocal, side: 'local' }],
        l.id,
        mine.slice(0, RUNS_KEPT_PER_LINK).map((r) => r.id),
        deps.journalMinAgeMs,
      );
  }

  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  /** Adds a server once its host key is in known_hosts and it runs Node.js 18+ over SSH. */
  async function addDevice(input: SyncDeviceInput): Promise<SyncDevice> {
    await load();
    const device = await checkNewDevice(input, {
      saved: await devicesOf(),
      fingerprint,
      probe: (d) => probe(launchDevice(d)),
    });
    await store.saveDevice(device);
    return device;
  }

  async function removeDevice(id: string) {
    await load();
    const user = links.find((l) => l.deviceId === id);
    if (user) throw new SyncError(`"${user.name}" syncs with this server. Remove that link first.`);
    await store.deleteDevice(id);
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  let realHome: Promise<string> | undefined;
  const homeReal = () => (realHome ??= realpath(home).catch(() => home));
  /** A two-way run writes here, and its undo copies live under the home folder: same volume. */
  const twoWayRoot = async (localRoot: string) => {
    if (!isWithin(await homeReal(), localRoot))
      throw new SyncError(
        'Two-way sync needs the project inside your home folder, where its undo copies are kept.',
      );
  };

  /** A catalog project and its real folder here: never the home folder itself. */
  async function projectOf(projectId: string) {
    const catalog = deps.catalog.getCatalog();
    const project = catalog.projects.find((p) => p.id === projectId);
    if (!project || !project.exists || project.isHome)
      throw new SyncError('Choose an existing project from Sources (rescan if it is new).');
    let localRoot: string;
    try {
      localRoot = await realpath(expand(project.path, home));
    } catch {
      throw new SyncError('The project folder could not be found on this machine.');
    }
    if (localRoot === home || !isAbsolute(localRoot))
      throw new SyncError('The home folder itself cannot be synced.');
    return { project, localRoot };
  }

  async function createLink(input: SyncLinkInput): Promise<SyncLink> {
    await load();
    if (localPlatform === 'win32') throw new SyncError('Project Sync runs on macOS and Linux.');
    if (!input.credentialsAck)
      throw new SyncError('Confirm that credential files such as .env are copied too.', 400);
    const { project, localRoot } = await projectOf(input.projectId);
    const direction = input.direction ?? 'two-way';
    if (direction === 'two-way') await twoWayRoot(localRoot);
    const d = await deviceOf(input.deviceId);
    const bad = validRemoteRoot(input.remoteRoot, d.home);
    if (bad) throw new SyncError(bad, 400);
    const same = links.find((l) => l.projectId === project.id);
    if (same)
      throw new SyncError(
        `"${same.name}" already links this project to a server. A project syncs with one server.`,
      );
    for (const other of links.filter((l) => l.deviceId === d.id))
      if (
        isWithin(other.remoteRoot, input.remoteRoot) ||
        isWithin(input.remoteRoot, other.remoteRoot)
      )
        throw new SyncError(
          `That folder overlaps "${other.name}" on this server. Each server folder has one owner.`,
        );
    const now = Date.now();
    const l: StoredLink = {
      id: randomUUID(),
      name: input.name.trim(),
      projectId: project.id,
      localPath: project.path,
      localRoot,
      deviceId: d.id,
      remoteRoot: input.remoteRoot,
      direction,
      ...(input.conflictPolicy === 'local' ? { conflictPolicy: 'local' as const } : {}),
      excludes: input.excludes,
      credentialsAckAt: now,
      hasBase: false,
      state: 'never',
      createdAt: now,
      updatedAt: now,
    };
    links.push(l);
    await store.saveLink(l);
    return publicLink(l);
  }

  async function updateLink(
    id: string,
    patch: {
      name?: string;
      excludes?: string[];
      direction?: SyncDirection;
      conflictPolicy?: SyncConflictPolicy;
    },
  ) {
    await load();
    const l = link(id);
    if (working && runs.find((r) => r.id === working)?.linkId === id)
      throw new SyncError('Wait for the running compare or run to finish.');
    const turning = patch.direction !== undefined && patch.direction !== l.direction;
    if (turning && patch.direction === 'two-way') await twoWayRoot(l.localRoot);
    let stale: string | undefined;
    if (patch.name !== undefined) l.name = patch.name.trim();
    if (
      patch.excludes !== undefined &&
      JSON.stringify(patch.excludes) !== JSON.stringify(l.excludes)
    ) {
      l.excludes = patch.excludes;
      stale = 'What is left out changed after this compare. Compare again.';
    }
    if (turning) {
      l.direction = patch.direction!;
      stale ??= 'The sync direction changed after this compare. Compare again.';
    }
    if (patch.conflictPolicy !== undefined && patch.conflictPolicy !== policyOf(l)) {
      if (patch.conflictPolicy === 'local') l.conflictPolicy = 'local';
      else delete l.conflictPolicy;
      stale ??= 'The “When both changed” setting changed after this compare. Compare again.';
    }
    if (stale) {
      const last = l.lastRunId ? runs.find((x) => x.id === l.lastRunId) : undefined;
      if (last && last.state !== 'running' && last.state !== 'comparing') {
        last.stale = stale;
        if (last.state === 'review') last.state = 'failed';
        await saveRunAndLink(last);
      }
    }
    l.updatedAt = Date.now();
    await store.saveLink(l);
    return publicLink(l);
  }

  async function removeLink(id: string) {
    await load();
    const gone = link(id);
    if (working && runs.find((r) => r.id === working)?.linkId === id)
      throw new SyncError('Wait for the running compare or run to finish.');
    for (const r of runs.filter((x) => x.linkId === id)) {
      entryCache.delete(r.id);
      await store.deleteRun(r.id);
    }
    runs = runs.filter((r) => r.linkId !== id);
    links = links.filter((l) => l.id !== id);
    await store.deleteLink(id);
    // Its undo journals have no run left to undo: removed on both sides, in the background.
    void deviceOf(gone.deviceId)
      .then((d) =>
        purgeJournals(
          [{ launch: launchDevice(d) }, { launch: launchLocal, side: 'local' }],
          id,
          [],
          0,
        ),
      )
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Compare
  // -------------------------------------------------------------------------

  async function compare(linkId: string): Promise<SyncRun> {
    await load();
    busyGuard();
    const l = link(linkId);
    const d = await deviceOf(l.deviceId);
    await check(d);
    busyGuard();
    const now = Date.now();
    const r: SyncRun = {
      id: randomUUID(),
      linkId,
      createdAt: now,
      updatedAt: now,
      state: 'comparing',
      counts: {},
      done: 0,
      failed: 0,
      total: 0,
      bytes: { toSend: 0, sent: 0, toGet: 0, got: 0 },
      groups: [],
      warnings: [],
      pendingDecisions: 0,
    };
    working = r.id;
    runs.unshift(r);
    l.lastRunId = r.id;
    try {
      await store.saveLink(l);
      await saveRunAndLink(r);
    } catch (e) {
      // Nothing started: free the slot, or every later compare, run and undo reads as busy.
      working = null;
      r.state = 'failed';
      r.error = clean(e);
      throw e;
    }
    void (async () => {
      try {
        let base = await store.loadBase(l.id);
        const [L, R] = await Promise.all([
          readManifest(launchLocal, { root: l.localRoot, excludes: l.excludes, base }),
          readManifest(launchDevice(d), {
            root: l.remoteRoot,
            excludes: l.excludes,
            base,
            inHome: true,
          }),
        ]);
        if (L.missing) throw new Error('The project folder is missing on this computer.');
        // A server folder that vanished, or is there but empty (wiped, recreated, a mount point
        // with nothing mounted), must never read as "the server deleted every file": the link
        // starts over as new, which copies this computer's files back (either direction).
        const emptied = R.missing || R.manifest.size === 0;
        const restart = emptied && base.size > 0;
        if (restart) base = new Map();
        const fold = l.direction === 'two-way' ? await foldLocal(l.localRoot) : undefined;
        const plan = classify(L.manifest, R.manifest, base, {
          localPlatform,
          devicePlatform: d.platform,
          direction: l.direction,
          conflictPolicy: policyOf(l),
          ...(fold ? { foldLocal: fold } : {}),
        });
        r.groups = plan.groups;
        r.warnings = warningsFor(plan.entries, l.direction);
        if (plan.settled) r.warnings.unshift(localWinsWarning(plan.settled));
        if (restart)
          r.warnings.unshift(
            R.missing
              ? `${l.remoteRoot} is gone on the server. This compare starts the link over: nothing here is deleted, and the run copies this computer's files there again.`
              : `${l.remoteRoot} is empty on the server. This compare starts the link over: nothing here is deleted, and the run copies this computer's files there again.`,
          );
        else if (R.missing)
          r.warnings.unshift(
            `${l.remoteRoot} does not exist on the server yet; the run creates it.`,
          );
        summarize(r, plan.entries);
        entryCache.set(r.id, plan.entries);
        await store.saveEntries(r.id, plan.entries);
        r.planned = true;
        r.state = 'review';
      } catch (e) {
        r.state = 'failed';
        r.error = clean(e);
      } finally {
        working = null;
        await saveRunAndLink(r).catch((e) =>
          log.error('project-sync', `Compare not saved: ${clean(e)}`),
        );
        await pruneRuns(l, d).catch((e) =>
          log.warn('project-sync', `Old runs not pruned: ${clean(e)}`),
        );
      }
    })();
    return copy(r);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  async function decide(runId: string, body: DecisionRequest): Promise<SyncRun> {
    await load();
    const r = run(runId);
    const l = link(r.linkId);
    const entries = await entriesOf(runId);
    // keep-both names its copy now, so the review shows where the server's version goes.
    const wantsCopy =
      Object.values(body.entries ?? {}).includes('keep-both') || body.bulk?.action === 'keep-both';
    const fold = wantsCopy ? await foldLocal(l.localRoot) : undefined;
    // Checked after the awaits: a run may have started meanwhile.
    if (r.state !== 'review')
      throw new SyncError('Decisions can only change before a run starts. Compare again.');
    const key = (p: string) => (fold ? fold(p) : p);
    const taken = new Set<string>();
    if (wantsCopy)
      for (const e of entries) {
        taken.add(key(e.path));
        if (e.copyPath) taken.add(key(e.copyPath));
      }
    const today = new Date();
    const nameCopy = (path: string) => {
      const name = keepBothPath(path, today, (p) => taken.has(key(p)));
      taken.add(key(name));
      return name;
    };
    const touched = applyDecisions({ entries, groups: r.groups }, body, l.direction, nameCopy);
    summarize(r, entries);
    await store.saveEntries(runId, touched);
    await saveRunAndLink(r);
    return copy(r);
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  async function localGitBusy(root: string, repo: string) {
    for (const name of ['index.lock', 'HEAD.lock'])
      try {
        await lstat(join(root, repo, name));
        return true;
      } catch {
        /* absent */
      }
    return false;
  }

  async function start(
    runId: string,
    opts: { confirmLiveSessions?: boolean; confirmDeletes?: boolean } = {},
  ): Promise<SyncRun> {
    await load();
    busyGuard();
    const r = run(runId);
    const l = link(r.linkId);
    if (l.lastRunId !== r.id)
      throw new SyncError('A newer compare exists for this link. Use that one.');
    if (r.stale) throw new SyncError(r.stale);
    if (!r.planned || !RUNNABLE.has(r.state)) throw new SyncError('Compare before running.');
    if (r.pendingDecisions > 0) throw new SyncError('Some changes still need a decision.');
    // Claim the slot before the first await: two Runs (or Run + Compare/Undo) must never interleave.
    working = r.id;
    let launched = false;
    try {
      const live = await liveSessionsIn(l.localRoot);
      if (live && !opts.confirmLiveSessions)
        throw new SyncError(
          `${live} AASC session${live === 1 ? ' is' : 's are'} working in this project; files may change during the run.`,
          409,
          'live-sessions',
        );
      const d = await deviceOf(l.deviceId);
      await check(d);
      const entries = await entriesOf(runId);
      const ask = massDeleteAsk(entries);
      if (ask && !opts.confirmDeletes) throw new SyncError(ask, 409, 'mass-delete');
      const b = r.bytes;
      await ensureRoom(spaceOf, launchDevice(d), l.remoteRoot, b.toSend - b.sent, 'the server');
      await ensureRoom(spaceOf, launchLocal, l.localRoot, (b.toGet ?? 0) - (b.got ?? 0), 'this computer');
      entryCache.set(r.id, entries);
      const before = { state: r.state, startedAt: r.startedAt, error: r.error };
      const was = entries.map((e) => ({ state: e.state, error: e.error }));
      let entriesSaved = false;
      try {
        // Retry: what failed gets another go, and so does what AASC stopped in the middle of
        // (every operation checks what it finds first, so a finished one is not redone).
        for (const e of entries)
          if (e.state === 'failed' || e.state === 'applying') {
            e.state = 'pending';
            delete e.error;
          }
        // Today's local git locks are checked afresh.
        for (const g of r.groups.filter((x) => x.isRepo))
          if (await localGitBusy(l.localRoot, g.id))
            for (const e of entries)
              if (e.groupId === g.id && e.state === 'pending' && isActing(e.action)) {
                e.state = 'failed';
                e.error =
                  'Git is busy on this computer (a .lock file exists). Retry when it finishes.';
              }
        for (const e of entries)
          if (
            e.state === 'pending' &&
            (e.action === 'keep' || e.action === 'skip') &&
            e.change !== 'same'
          )
            e.state = 'skipped';
        cancelled.delete(r.id);
        r.state = 'running';
        r.startedAt ??= Date.now();
        delete r.error;
        summarize(r, entries);
        await store.saveEntries(r.id, entries);
        entriesSaved = true;
        await saveRunAndLink(r);
      } catch (err) {
        // Nothing runs: the run and its entries keep what they had, so Retry and Undo still answer.
        entries.forEach((e, i) => {
          e.state = was[i].state;
          if (was[i].error === undefined) delete e.error;
          else e.error = was[i].error;
        });
        Object.assign(r, before);
        summarize(r, entries);
        if (entriesSaved)
          await store
            .saveEntries(r.id, entries)
            .catch((e) => log.error('project-sync', `Run entries not rolled back: ${clean(e)}`));
        throw err;
      }
      launched = true;
      void executeRun(
        {
          store,
          launchLocal,
          launchDevice: launchDevice(d),
          saveEveryMs,
          stopped: () => cancelled.has(r.id),
          saveRun: saveRunAndLink,
        },
        r,
        l,
        entries,
      ).finally(() => {
        cancelled.delete(r.id);
        working = null;
      });
      return copy(r);
    } finally {
      if (!launched) working = null;
    }
  }

  /** AASC sessions busy inside the project, matched on real paths (a session may name a link). */
  async function liveSessionsIn(root: string) {
    const paths = (deps.activeSessionPaths?.() ?? []).filter((p) => isAbsolute(p));
    const real = await Promise.all(paths.map((p) => realpath(p).catch(() => p)));
    return real.filter((p) => isWithin(root, p)).length;
  }

  async function cancel(runId: string) {
    await load();
    const r = run(runId);
    if (r.state !== 'running') throw new SyncError('That run is not running.');
    cancelled.add(r.id);
    return copy(r);
  }

  /** Undo puts back what the latest run changed, on each side it wrote to (the server first). */
  async function undo(runId: string) {
    await load();
    busyGuard();
    const r = run(runId);
    const l = link(r.linkId);
    if (l.lastRunId !== r.id) throw new SyncError('Only the latest run of a link can be undone.');
    // Only a run that started can have written; a stopped one may have written part of an entry.
    const touched =
      r.startedAt !== undefined &&
      (r.done > 0 || r.state === 'interrupted' || r.state === 'failed' || r.state === 'cancelled');
    if (
      !['complete', 'partial', 'cancelled', 'failed', 'interrupted'].includes(r.state) ||
      !touched
    )
      throw new SyncError('Nothing from this run changed either side.');
    working = r.id;
    try {
      const d = await deviceOf(l.deviceId);
      await check(d);
      const result = await undoRunSides(
        { store, launchLocal, launchDevice: launchDevice(d), saveRun: saveRunAndLink },
        r,
        l,
        await entriesOf(r.id),
      );
      return { run: copy(r), ...result };
    } finally {
      working = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function page(
    runId: string,
    q: { filter?: SyncEntryFilter; group?: string; offset?: number; limit?: number },
  ): Promise<SyncEntryPage> {
    await load();
    run(runId);
    const all = await entriesOf(runId);
    const f = q.filter ?? 'changes';
    const hit = (e: SyncEntry) =>
      (q.group === undefined || e.groupId === q.group) &&
      (f === 'all' ||
        (f === 'changes' && e.change !== 'same') ||
        (f === 'decisions' && e.action === 'review') ||
        (f === 'credentials' && e.flags.includes('credential')) ||
        (f === 'links' && (e.local ?? e.device)?.kind === 'symlink') ||
        (f === 'failed' && e.state === 'failed'));
    const matched = all.filter(hit);
    const offset = Math.max(0, q.offset ?? 0),
      limit = Math.min(500, Math.max(1, q.limit ?? 200));
    return {
      entries: matched.slice(offset, offset + limit).map((e) => publicEntry(copy(e))),
      total: matched.length,
      offset,
    };
  }

  async function diff(runId: string, entryId: string) {
    await load();
    const r = run(runId);
    const l = link(r.linkId);
    const e = (await entriesOf(runId)).find((x) => x.id === entryId);
    if (!e) throw new SyncError('Entry not found.', 404);
    return previewDiff(e, {
      launchLocal,
      localRoot: l.localRoot,
      device: async () => {
        const d = await deviceOf(l.deviceId);
        await check(d);
        return { launch: launchDevice(d), root: l.remoteRoot };
      },
    });
  }

  const pulls = createPulls({
    launchLocal,
    launchDevice: (d) => launchDevice(d),
    deviceOf,
    check,
    projectRoot: async (projectId) => {
      const { project, localRoot } = await projectOf(projectId);
      // Each part's undo journal lives under the home folder, on the same volume.
      if (!isWithin(await homeReal(), localRoot))
        throw new SyncError('Pulled files land in a project inside your home folder.');
      return { root: localRoot, display: project.path };
    },
    claim: (id) => {
      busyGuard();
      working = id;
    },
    release: (id) => {
      if (working === id) working = null;
    },
    spaceOf,
    journalMinAgeMs: deps.journalMinAgeMs,
  });

  return {
    load,
    overview: async (): Promise<SyncOverview> => {
      await load();
      return copy({
        links: links.map(publicLink),
        runs,
        devices: await devicesOf(),
        supported: localPlatform !== 'win32',
      });
    },
    addDevice,
    removeDevice,
    createLink,
    updateLink,
    removeLink,
    compare,
    decide,
    run: start,
    cancel,
    undo,
    getRun: async (id: string) => {
      await load();
      return copy(run(id));
    },
    entries: page,
    diff,
    /** One level of a folder on a saved server, inside its home (default: home). */
    browse: async (deviceId: string, path?: string) => {
      await load();
      const d = await deviceOf(deviceId);
      await check(d);
      return browseFolder(launchDevice(d), d.home, path);
    },
    planPull: async (input: SyncPullInput) => {
      await load();
      if (localPlatform === 'win32') throw new SyncError('Project Sync runs on macOS and Linux.');
      return pulls.planPull(input);
    },
    startPull: pulls.startPull,
    getPull: pulls.getPull,
    cancelPull: pulls.cancelPull,
    undoPull: pulls.undoPull,
  };
}
export type SyncService = ReturnType<typeof createSyncService>;
