/**
 * Project Sync service: links, compare → frozen plan → review → run, undo, and the base.
 * One compare/run/undo at a time. Design: docs/plans/project-sync-design.md.
 */
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { lstat, open, realpath } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join, posix } from 'path';
import { createTwoFilesPatch } from 'diff';
import type { ResourceCatalogService } from '../resourceCatalog.js';
import { isWithin } from '../fsSafe.js';
import { redactPatch, redactPemBlocks, redactSecretsInString } from '../resourceMask.js';
import {
  knownFingerprint,
  nodeEvalCommand,
  spawnPinnedSsh,
} from '../resourceTransfers/transport.js';
import { applyOrder, classify, repoEntryAction } from './classify.js';
import {
  applyOps,
  localLauncher,
  readManifest,
  readText,
  undoRun,
  type Launcher,
} from './helperClient.js';
import { PROJECT_HELPER } from './projectHelper.js';
import { sqliteStore, type StoredLink, type SyncStore } from './store.js';
import type { TransferDevice } from '../../src/types/resourceTransfers.js';
import {
  allowedSyncActions,
  type FileMeta,
  type SyncAction,
  type SyncChange,
  type SyncEntry,
  type SyncEntryFilter,
  type SyncEntryPage,
  type SyncGroupDecision,
  type SyncLink,
  type SyncLinkInput,
  type SyncOverview,
  type SyncRun,
} from '../../src/types/projectSync.js';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface SyncServiceDeps {
  catalog: Pick<ResourceCatalogService, 'getCatalog'>;
  home?: string;
  store?: SyncStore | Promise<SyncStore>;
  /** Saved SSH devices (the Devices sub-tab). Default: read from the transfer state. */
  devices?: () => Promise<TransferDevice[]>;
  fingerprint?: (d: TransferDevice) => Promise<string>;
  launchLocal?: Launcher;
  launchDevice?: (d: TransferDevice) => Launcher;
  /** Absolute project paths of AASC sessions that are busy right now (working/prompting/approval/input). */
  activeSessionPaths?: () => string[];
  localPlatform?: string;
  /** Persist progress at most this often while a run is going (ms). */
  saveEveryMs?: number;
}

const RUNS_KEPT_PER_LINK = 10;
const DIFF_MAX = 256 * 1024;
const ACTIVE_RUN: ReadonlySet<SyncRun['state']> = new Set(['comparing', 'running']);
const RUNNABLE: ReadonlySet<SyncRun['state']> = new Set([
  'review',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

const clean = (e: unknown) =>
  redactSecretsInString(e instanceof Error ? e.message : 'Project sync failed.').slice(0, 500);

async function defaultDevices(): Promise<TransferDevice[]> {
  const { loadResourceTransferState } = await import('../db.js');
  const raw = loadResourceTransferState();
  return raw ? ((JSON.parse(raw) as { devices?: TransferDevice[] }).devices ?? []) : [];
}

/** `~/x` (catalog display path) → absolute. */
function expand(display: string, home: string): string {
  if (display === '~') return home;
  return display.startsWith('~/') ? join(home, display.slice(2)) : display;
}

export function validRemoteRoot(root: string, deviceHome: string): string | null {
  if (!posix.isAbsolute(root) || /[\x00-\x1f]/.test(root) || root.length > 4096)
    return 'Use an absolute folder path.';
  if (posix.normalize(root) !== root || root.endsWith('/'))
    return 'Use a plain path without "..", "//" or a trailing slash.';
  if (root === deviceHome) return 'The device folder cannot be the home folder itself.';
  if (!root.startsWith(deviceHome + '/')) return `The device folder must be inside ${deviceHome}.`;
  if (
    root
      .split('/')
      .some((seg) => ['.ssh', '.gnupg', '.aws', '.kube', '.aasc-project-sync'].includes(seg))
  )
    return 'That folder holds credentials or AASC state; choose a project folder.';
  return null;
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
  const devicesOf = deps.devices ?? defaultDevices;
  const fingerprint = deps.fingerprint ?? knownFingerprint;
  const launchLocal = deps.launchLocal ?? localLauncher();
  const launchDevice =
    deps.launchDevice ??
    ((d: TransferDevice): Launcher =>
      () =>
        spawnPinnedSsh(d, nodeEvalCommand(PROJECT_HELPER)));
  const localPlatform = deps.localPlatform ?? process.platform;
  const saveEveryMs = deps.saveEveryMs ?? 1000;

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
    if (!d) throw new SyncError('Device not found. Add it under Devices first.');
    return d;
  };
  const check = async (d: TransferDevice) => {
    if ((await fingerprint(d)) !== d.fingerprint)
      throw new SyncError(
        'Trusted host keys changed. Verify the device in your terminal, then add it again.',
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

  function summarize(r: SyncRun, entries: SyncEntry[]) {
    const counts: Partial<Record<SyncChange, number>> = {};
    let toSend = 0,
      total = 0,
      done = 0,
      failed = 0,
      pending = 0;
    const repoGroups = new Set(r.groups.filter((g) => g.isRepo).map((g) => g.id));
    for (const e of entries) {
      counts[e.change] = (counts[e.change] ?? 0) + 1;
      if (e.action === 'push' || e.action === 'delete-device') {
        total++;
        if (e.state === 'done') done++;
        if (e.state === 'failed') failed++;
        if (e.action === 'push' && e.local?.kind === 'file') toSend += e.local.size;
      }
      if (e.action === 'review' && !repoGroups.has(e.groupId)) pending++;
    }
    pending += r.groups.filter((g) => g.isRepo && g.decision === 'review').length;
    Object.assign(r, { counts, total, done, failed, pendingDecisions: pending });
    r.bytes = { toSend, sent: r.bytes?.sent ?? 0 };
  }

  function warningsFor(entries: SyncEntry[]): string[] {
    const n = (flag: SyncEntry['flags'][number]) =>
      entries.filter((e) => e.flags.includes(flag) && e.change !== 'same').length;
    const w: string[] = [];
    const creds = entries.filter((e) => e.flags.includes('credential')).length;
    if (creds)
      w.push(
        `${creds} credential file${creds === 1 ? '' : 's'} (such as .env) will be copied as-is. Their contents are never shown here.`,
      );
    if (n('live-db'))
      w.push('A database is open (it has a -wal file): its copy may be inconsistent.');
    if (n('native-artifact'))
      w.push(
        'Native modules built for this machine will not run on the device (different platform).',
      );
    if (n('link-outside'))
      w.push('Some links point outside the project; the device may not have their targets.');
    const deletes = entries.filter((e) => e.change === 'delete').length;
    const based = entries.filter((e) => e.base).length;
    if (deletes >= 20 && deletes * 2 >= based)
      w.unshift(
        `${deletes} of ${based} synced files are gone on this machine and would be deleted on the device (to its trash). Is the project folder complete?`,
      );
    if (n('worktree-gitdir'))
      w.push(
        'A linked git worktree points at a folder on this machine; it will not work on the device.',
      );
    return w;
  }

  function linkState(l: StoredLink): SyncLink['state'] {
    const last = l.lastRunId ? runs.find((r) => r.id === l.lastRunId) : undefined;
    if (!last) return 'never';
    if (ACTIVE_RUN.has(last.state)) return 'running';
    if (last.state === 'complete') return last.failed ? 'attention' : 'in-sync';
    if (last.state === 'partial' || last.state === 'failed' || last.state === 'interrupted')
      return 'attention';
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

  async function pruneRuns(linkId: string) {
    const mine = runs.filter((r) => r.linkId === linkId).sort((a, b) => b.createdAt - a.createdAt);
    for (const old of mine.slice(RUNS_KEPT_PER_LINK)) {
      runs = runs.filter((r) => r.id !== old.id);
      entryCache.delete(old.id);
      await store.deleteRun(old.id);
    }
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async function createLink(input: SyncLinkInput): Promise<SyncLink> {
    await load();
    if (!input.credentialsAck)
      throw new SyncError('Confirm that credential files such as .env are copied too.', 400);
    const catalog = deps.catalog.getCatalog();
    const project = catalog.projects.find((p) => p.id === input.projectId);
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
    const d = await deviceOf(input.deviceId);
    const bad = validRemoteRoot(input.remoteRoot, d.home);
    if (bad) throw new SyncError(bad, 400);
    for (const other of links.filter((l) => l.deviceId === d.id)) {
      if (other.projectId === project.id)
        throw new SyncError(`"${other.name}" already links this project to this device.`);
      if (
        isWithin(other.remoteRoot, input.remoteRoot) ||
        isWithin(input.remoteRoot, other.remoteRoot)
      )
        throw new SyncError(
          `That folder overlaps "${other.name}" on this device. Each device folder has one owner.`,
        );
    }
    const now = Date.now();
    const l: StoredLink = {
      id: randomUUID(),
      name: input.name.trim(),
      projectId: project.id,
      localPath: project.path,
      localRoot,
      deviceId: d.id,
      remoteRoot: input.remoteRoot,
      direction: 'push',
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

  async function updateLink(id: string, patch: { name?: string; excludes?: string[] }) {
    await load();
    const l = link(id);
    if (working && runs.find((r) => r.id === working)?.linkId === id)
      throw new SyncError('Wait for the running compare or run to finish.');
    if (patch.name !== undefined) l.name = patch.name.trim();
    if (
      patch.excludes !== undefined &&
      JSON.stringify(patch.excludes) !== JSON.stringify(l.excludes)
    ) {
      l.excludes = patch.excludes;
      const last = l.lastRunId ? runs.find((x) => x.id === l.lastRunId) : undefined;
      if (last && last.state !== 'running' && last.state !== 'comparing') {
        last.stale = 'What is left out changed after this compare. Compare again.';
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
    link(id);
    if (working && runs.find((r) => r.id === working)?.linkId === id)
      throw new SyncError('Wait for the running compare or run to finish.');
    for (const r of runs.filter((x) => x.linkId === id)) {
      entryCache.delete(r.id);
      await store.deleteRun(r.id);
    }
    runs = runs.filter((r) => r.linkId !== id);
    links = links.filter((l) => l.id !== id);
    await store.deleteLink(id);
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
      bytes: { toSend: 0, sent: 0 },
      groups: [],
      warnings: [],
      pendingDecisions: 0,
    };
    working = r.id;
    runs.unshift(r);
    l.lastRunId = r.id;
    await store.saveLink(l);
    await saveRunAndLink(r);
    void (async () => {
      try {
        const base = await store.loadBase(l.id);
        const [L, R] = await Promise.all([
          readManifest(launchLocal, { root: l.localRoot, excludes: l.excludes, base }),
          readManifest(launchDevice(d), {
            root: l.remoteRoot,
            excludes: l.excludes,
            base,
            inHome: true,
          }),
        ]);
        if (L.missing) throw new Error('The project folder is missing on this machine.');
        const plan = classify(L.manifest, R.manifest, base, {
          localPlatform,
          devicePlatform: d.platform,
        });
        r.groups = plan.groups;
        r.warnings = warningsFor(plan.entries);
        if (R.missing)
          r.warnings.unshift(
            `${l.remoteRoot} does not exist on the device yet; the run creates it.`,
          );
        summarize(r, plan.entries);
        entryCache.set(r.id, plan.entries);
        await store.saveEntries(r.id, plan.entries);
        r.state = 'review';
      } catch (e) {
        r.state = 'failed';
        r.error = clean(e);
      } finally {
        working = null;
        await saveRunAndLink(r).catch(() => {});
        await pruneRuns(linkId).catch(() => {});
      }
    })();
    return copy(r);
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  async function decide(
    runId: string,
    body: {
      entries?: Record<string, SyncAction>;
      groups?: Record<string, SyncGroupDecision>;
      bulk?: { change: SyncChange; action: SyncAction };
    },
  ): Promise<SyncRun> {
    await load();
    const r = run(runId);
    if (r.state !== 'review')
      throw new SyncError('Decisions can only change before a run starts. Compare again.');
    const entries = await entriesOf(runId);
    const repos = new Map(r.groups.filter((g) => g.isRepo).map((g) => [g.id, g]));
    const byId = new Map(entries.map((e) => [e.id, e]));
    const valid = (e: SyncEntry, a: SyncAction) =>
      allowedSyncActions(e.change).includes(a) &&
      (a !== 'push' || !!e.local) &&
      (a !== 'delete-device' || (!e.local && !!e.device));
    const touched: SyncEntry[] = [];
    for (const [groupId, decision] of Object.entries(body.groups ?? {})) {
      const g = repos.get(groupId);
      if (!g) throw new SyncError('Only repositories are decided as a group.', 400);
      if (g.state === 'busy')
        throw new SyncError('Git is busy in that repository. Compare again when it finishes.');
      if (!['sync', 'overwrite', 'skip'].includes(decision))
        throw new SyncError('Invalid repository decision.', 400);
      if (decision === 'sync' && (g.state === 'device-changed' || g.state === 'different-repo'))
        throw new SyncError(
          'The device copy of this repository changed: choose Overwrite or Skip.',
        );
      g.decision = decision;
      for (const e of entries)
        if (e.groupId === groupId) {
          e.action = repoEntryAction(e, decision);
          touched.push(e);
        }
    }
    const apply = (e: SyncEntry, a: SyncAction) => {
      if (repos.has(e.groupId))
        throw new SyncError('Decide repository files with the repository row.', 400);
      if (!valid(e, a)) throw new SyncError(`"${a}" is not possible for ${e.path}.`, 400);
      e.action = a;
      touched.push(e);
    };
    for (const [id, a] of Object.entries(body.entries ?? {})) {
      const e = byId.get(id);
      if (!e) throw new SyncError('Entry not found.', 404);
      apply(e, a);
    }
    if (body.bulk)
      for (const e of entries)
        if (e.change === body.bulk.change && !repos.has(e.groupId) && valid(e, body.bulk.action)) {
          e.action = body.bulk.action;
          touched.push(e);
        }
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
    opts: { confirmLiveSessions?: boolean } = {},
  ): Promise<SyncRun> {
    await load();
    busyGuard();
    const r = run(runId);
    const l = link(r.linkId);
    if (l.lastRunId !== r.id)
      throw new SyncError('A newer compare exists for this link. Use that one.');
    if (r.stale) throw new SyncError(r.stale);
    if (!RUNNABLE.has(r.state)) throw new SyncError('Compare before running.');
    if (r.pendingDecisions > 0) throw new SyncError('Some changes still need a decision.');
    const live = (deps.activeSessionPaths?.() ?? []).filter(
      (p) => isAbsolute(p) && isWithin(l.localRoot, p),
    );
    if (live.length && !opts.confirmLiveSessions)
      throw new SyncError(
        `${live.length} AASC session${live.length === 1 ? ' is' : 's are'} working in this project; files may change during the run.`,
        409,
        'live-sessions',
      );
    // Claim the slot before the first await: two Runs (or Run + Compare/Undo) must never interleave.
    working = r.id;
    let launched = false;
    try {
      const d = await deviceOf(l.deviceId);
      await check(d);
      const entries = await entriesOf(runId);
      entryCache.set(r.id, entries);
      // Retry: everything that failed gets another go — then today's local git locks are checked afresh.
      for (const e of entries)
        if (e.state === 'failed') {
          e.state = 'pending';
          delete e.error;
        }
      for (const g of r.groups.filter((x) => x.isRepo))
        if (await localGitBusy(l.localRoot, g.id))
          for (const e of entries)
            if (
              e.groupId === g.id &&
              e.state === 'pending' &&
              (e.action === 'push' || e.action === 'delete-device')
            ) {
              e.state = 'failed';
              e.error =
                'Git is busy on this machine (a .lock file exists). Retry when it finishes.';
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
      delete r.error;
      summarize(r, entries);
      await store.saveEntries(r.id, entries);
      await saveRunAndLink(r);
      launched = true;
      void execute(r, l, d, entries).finally(() => {
        working = null;
      });
      return copy(r);
    } finally {
      if (!launched) working = null;
    }
  }

  async function execute(r: SyncRun, l: StoredLink, d: TransferDevice, entries: SyncEntry[]) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const dirty = new Map<string, SyncEntry>();
    let lastSave = Date.now();
    const flush = async () => {
      const list = [...dirty.values()];
      dirty.clear();
      summarize(r, entries);
      if (list.length) await store.saveEntries(r.id, list);
      await saveRunAndLink(r);
      lastSave = Date.now();
    };
    try {
      const deviceMap = new Map<string, FileMeta>(
        entries.filter((e) => e.device).map((e) => [e.path, e.device!]),
      );
      const pending = entries.filter((e) => e.state === 'pending');
      const ops = applyOrder(pending, deviceMap);
      const sent = new Set(ops.map((o) => o.entryId));
      // Acting entries with no op are already true on the device (a delete inside a folder that
      // goes to the backup whole, or a delete of something already gone).
      for (const e of pending)
        if ((e.action === 'push' || e.action === 'delete-device') && !sent.has(e.id)) {
          e.state = 'done';
          dirty.set(e.id, e);
        }
      for (const o of ops) byId.get(o.entryId)!.state = 'applying';
      try {
        await applyOps(
          launchDevice(d),
          { root: l.remoteRoot, linkId: l.id, runId: r.id },
          l.localRoot,
          ops,
          {
            cancelled: () => cancelled.has(r.id),
            onSent: (n) => {
              r.bytes.sent += n;
            },
            onAck: (ack) => {
              const e = byId.get(ack.id);
              if (!e) return;
              e.state = ack.state;
              if (ack.error) e.error = redactSecretsInString(ack.error).slice(0, 300);
              else delete e.error;
              dirty.set(e.id, e);
              if (Date.now() - lastSave > saveEveryMs) void flush().catch(() => {});
            },
          },
        );
      } catch (err) {
        r.error = clean(err);
      }
      for (const o of ops) {
        const e = byId.get(o.entryId)!;
        if (e.state === 'applying') {
          e.state = cancelled.has(r.id) ? 'pending' : 'failed';
          if (e.state === 'failed')
            e.error = r.error ?? 'Not applied. Retry continues where it stopped.';
          dirty.set(e.id, e);
        }
      }
      // The base: what both sides now hold for certain.
      const base = await store.loadBase(l.id);
      for (const e of entries) {
        if (e.change === 'same' && e.local) base.set(e.path, e.local);
        else if (e.state === 'done' && e.action === 'push' && e.local) base.set(e.path, e.local);
        else if (e.state === 'done' && e.action === 'delete-device') base.delete(e.path);
        else if (e.change === 'delete' && e.action === 'keep') base.delete(e.path);
      }
      await store.replaceBase(l.id, base);
      l.hasBase = base.size > 0;
      l.updatedAt = Date.now();
      await store.saveLink(l);
    } catch (err) {
      // Never leave a run "running": a store failure ends it as failed with its reason.
      r.error = r.error ?? clean(err);
      for (const e of entries)
        if (e.state === 'applying') {
          e.state = 'failed';
          e.error = r.error;
          dirty.set(e.id, e);
        }
    } finally {
      summarize(r, entries);
      r.state = cancelled.has(r.id)
        ? 'cancelled'
        : r.failed === 0 && !r.error
          ? 'complete'
          : r.done > 0
            ? 'partial'
            : 'failed';
      if (r.state === 'complete') delete r.error;
      cancelled.delete(r.id);
      await flush().catch(() => {});
    }
  }

  async function cancel(runId: string) {
    await load();
    const r = run(runId);
    if (r.state !== 'running') throw new SyncError('That run is not running.');
    cancelled.add(r.id);
    return copy(r);
  }

  async function undo(runId: string) {
    await load();
    busyGuard();
    const r = run(runId);
    const l = link(r.linkId);
    if (l.lastRunId !== r.id) throw new SyncError('Only the latest run of a link can be undone.');
    const touched = r.done > 0 || r.state === 'interrupted' || r.state === 'failed';
    if (
      !['complete', 'partial', 'cancelled', 'failed', 'interrupted'].includes(r.state) ||
      !touched
    )
      throw new SyncError('Nothing from this run reached the device.');
    working = r.id;
    try {
      const d = await deviceOf(l.deviceId);
      await check(d);
      const result = await undoRun(launchDevice(d), {
        root: l.remoteRoot,
        linkId: l.id,
        runId: r.id,
      });
      r.state = 'undone';
      r.warnings = [
        `Undo restored ${result.restored} item${result.restored === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} changed on the device since and were left alone` : ''}.`,
        ...r.warnings,
      ];
      // The device no longer matches what the base says; the next compare runs as a first run.
      await store.replaceBase(l.id, new Map());
      l.hasBase = false;
      await store.saveLink(l);
      await saveRunAndLink(r);
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

  async function diff(
    runId: string,
    entryId: string,
  ): Promise<{ patch: string | null; note?: string }> {
    await load();
    const r = run(runId);
    const l = link(r.linkId);
    const e = (await entriesOf(runId)).find((x) => x.id === entryId);
    if (!e) throw new SyncError('Entry not found.', 404);
    if (e.flags.includes('credential'))
      return { patch: null, note: 'Credential files are never previewed.' };
    const left = e.device,
      right = e.local;
    if ((left && left.kind !== 'file') || (right && right.kind !== 'file'))
      return { patch: null, note: 'Only files have a text preview.' };
    if ((left?.size ?? 0) > DIFF_MAX || (right?.size ?? 0) > DIFF_MAX)
      return { patch: null, note: 'Too large to preview (over 256 KB).' };
    let mine: Buffer = Buffer.alloc(0);
    if (right)
      mine =
        (await readText(launchLocal, { root: l.localRoot, path: e.path, max: DIFF_MAX })) ??
        Buffer.alloc(0);
    let theirs: Buffer = Buffer.alloc(0);
    if (left) {
      const d = await deviceOf(l.deviceId);
      await check(d);
      theirs =
        (await readText(launchDevice(d), {
          root: l.remoteRoot,
          path: e.path,
          max: DIFF_MAX,
          inHome: true,
        })) ?? Buffer.alloc(0);
    }
    if (mine.includes(0) || theirs.includes(0))
      return { patch: null, note: 'Binary file — no text preview.' };
    const patch = await new Promise<string | undefined>((resolve) =>
      createTwoFilesPatch(
        'Device',
        'This machine',
        redactPemBlocks(theirs.toString('utf8')),
        redactPemBlocks(mine.toString('utf8')),
        undefined,
        undefined,
        {
          context: 3,
          timeout: 1500,
          callback: (p) => resolve(p ? redactPatch(p).slice(0, 40000) : undefined),
        },
      ),
    );
    return patch ? { patch } : { patch: null, note: 'The preview took too long.' };
  }

  return {
    load,
    overview: async (): Promise<SyncOverview> => {
      await load();
      return copy({ links: links.map(publicLink), runs });
    },
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
    /** Transfers asks before copying into a folder a link keeps (one owner per device path). */
    linkedFolder: (deviceId: string, raw: string): string | null => {
      const folder = posix.normalize(raw).replace(/(.)\/+$/, '$1');
      return (
        links.find(
          (l) =>
            l.deviceId === deviceId &&
            (isWithin(l.remoteRoot, folder) || isWithin(folder, l.remoteRoot)),
        )?.name ?? null
      );
    },
    deviceInUse: (deviceId: string) => links.some((l) => l.deviceId === deviceId),
  };
}
export type SyncService = ReturnType<typeof createSyncService>;
