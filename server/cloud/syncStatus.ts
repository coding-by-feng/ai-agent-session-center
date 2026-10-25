/**
 * AASC-62: which saved resources differ between this device and the cloud.
 *
 * A resource syncs once it was saved to cloud from this device or installed here: its catalog id
 * then maps to a cloud resource (`resource-id`) and records the version last synced
 * (`published`). Each cloud head is compared by its portable files (path, SHA-256, mode) with what
 * is on disk now, and, when the cloud moved on, with the version this device last synced:
 *
 *   on disk = cloud head                      → synced
 *   cloud head = last synced, disk differs    → local-changed
 *   cloud moved on, disk = last synced        → cloud-newer
 *   cloud moved on, disk differs from both    → conflict
 *   not on this device                        → cloud-only (or conflict / synced when the same
 *                                               place already holds a copy)
 *   stopped on this device ("Stop syncing")   → stopped: never moves here until Sync again
 *   synced here, but the cloud has none left  → removed (Remove from cloud on some device): never
 *                                               uploaded again by Sync now
 *
 * Reading the status writes only local bookkeeping: an identical copy is recorded as synced at
 * the cloud's version. No file is ever written here.
 */
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import {
  ResourceVersionSchema,
  type InstallDecisions,
  type InstallPlan,
  type PackageManifest,
  type ResourceVersion,
  type SyncItem,
} from '../../src/types/cloudResources.js';
import type { InternalResource } from '../resourceScanner.js';
import { readPublicationPacket } from '../resourcePackages/packet.js';
import { resourceDestination, type AdapterRoots } from '../resourcePackages/adapters.js';
import { cloudPublicationBlocker } from '../resourcePackages/policy.js';
import { accountKey, type CloudBinding } from './binding.js';
import type { JobStore } from './jobStore.js';
import { validatedVersion } from './packageFiles.js';
import { portableFiles } from './publication.js';
import { CloudError, type CloudConnector } from './types.js';

/** 100 pages of 100: the most cloud resources one status read lists. */
export const MAX_SYNC_PAGES = 100;
const PAGE = z
  .object({ items: z.array(ResourceVersionSchema).max(100), nextCursor: z.uuid().nullable() })
  .strict();

export interface SyncEntry {
  item: SyncItem;
  /** The local catalog resource it syncs with, when this device has one. */
  catalogId: string | null;
  /** The cloud's latest version, when the cloud has one. */
  head: ResourceVersion | null;
}
interface Published {
  resourceId: string;
  version: number;
}
const WAITING: SyncItem['state'][] = ['local-changed', 'cloud-newer', 'cloud-only', 'conflict'];
/** What "Stop syncing on this Mac" stores, per account and cloud resource (`sync-stopped`). */
export interface SyncStopMark {
  resourceId: string;
  at: number;
}
export const syncWaiting = (items: SyncItem[]) =>
  items.filter((i) => WAITING.includes(i.state)).length;

/**
 * What Sync now decides for each item of its install plan, dependencies included (security
 * review, Oct 23 2026): blocked → skip; memory without this run's OK → skip (held back, reported);
 * held by this device (changed here, a conflict without a choice, stopped) → keep-local, never
 * overwritten, and never added; kept (not asked for in a Sync now with `only`) → a copy here stays
 * as it is, a missing one may be added; any other replacement → replace-with-backup. A dependent
 * of an item it did not install is left unchanged by the install runner ("A dependency was not
 * installed…").
 */
export function syncInstallDecisions(
  items: readonly {
    id: string;
    resourceId: string;
    action: InstallPlan['items'][number]['action'];
    memory: boolean;
  }[],
  held: ReadonlySet<string>,
  okMemory: ReadonlySet<string>,
  kept: ReadonlySet<string> = new Set(),
): { decisions: InstallDecisions; heldBack: string[] } {
  const decisions: InstallDecisions = {},
    heldBack: string[] = [];
  for (const i of items) {
    if (i.action === 'blocked') decisions[i.id] = 'skip';
    else if (i.memory && !okMemory.has(i.resourceId)) {
      decisions[i.id] = 'skip';
      heldBack.push(i.resourceId);
    } else if (held.has(i.resourceId))
      decisions[i.id] = i.action === 'replace' ? 'keep-local' : 'skip';
    else if (kept.has(i.resourceId) && i.action === 'replace') decisions[i.id] = 'keep-local';
    else if (i.action === 'replace') decisions[i.id] = 'replace-with-backup';
  }
  return { decisions, heldBack };
}

/** How a dependency that holds an upload back is described ("It needs “x”, which …"). */
const DEPENDENCY_WORDS: Record<SyncItem['state'], string> = {
  'local-changed': 'has changes of its own that this sync leaves as they are',
  'cloud-newer': 'is newer in the cloud',
  'cloud-only': 'is only in the cloud',
  conflict: 'changed in both places',
  blocked: "can't sync",
  stopped: 'is stopped on this Mac',
  removed: 'was removed from the cloud',
  synced: 'is synced',
};

/**
 * Uploads that must wait (review, Oct 23 2026). A publication publishes every dependency again
 * with the resource that needs it (exact pins), so a dependency this sync does not move on purpose
 * — stopped, removed, newer in the cloud, changed in both places, or changed here but not part of
 * this sync — would ride along: a stopped one would move, a removed one come back, a newer cloud
 * version be overwritten. A dependency may only be synced or new to the cloud. Returns each
 * waiting upload's catalog id with the reason.
 */
export function uploadsWaitingOnDependencies(
  plan: readonly {
    catalogId: string;
    manifest: Pick<PackageManifest, 'resourceId' | 'dependencies'>;
  }[],
  uploads: ReadonlySet<string>,
  items: ReadonlyMap<string, SyncItem>,
): Map<string, string> {
  const byCloudId = new Map(plan.map((p) => [p.manifest.resourceId, p]));
  const memo = new Map<string, SyncItem | null>();
  /** The first dependency in a resource's closure that may not ride along, if any. */
  const offender = (id: string, path: ReadonlySet<string>): SyncItem | null => {
    if (memo.has(id)) return memo.get(id)!;
    const p = byCloudId.get(id);
    if (!p || path.has(id)) return null; // the planner refuses cycles
    const own = items.get(id);
    let found = !uploads.has(p.catalogId) && own && own.state !== 'synced' ? own : null;
    for (const d of p.manifest.dependencies)
      found ??= offender(d.resourceId, new Set([...path, id]));
    memo.set(id, found);
    return found;
  };
  const waiting = new Map<string, string>();
  for (const p of plan) {
    if (!uploads.has(p.catalogId)) continue;
    const dep = p.manifest.dependencies
      .map((d) => offender(d.resourceId, new Set([p.manifest.resourceId])))
      .find(Boolean);
    if (dep)
      waiting.set(
        p.catalogId,
        `It needs “${dep.name}”, which ${DEPENDENCY_WORDS[dep.state]}, so it waits.`,
      );
  }
  return waiting;
}
/** Only our own plain refusals and CloudError messages reach the browser (as in publication). */
function reasonOf(error: unknown): string {
  return error instanceof CloudError
    ? error.message
    : error instanceof Error && error.constructor === Error && !('code' in error)
      ? error.message
      : 'This resource could not be read safely. Rescan and try again.';
}
function sameFiles(a: PackageManifest['files'], b: PackageManifest['files']): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((f) => [f.path, f]));
  return b.every((f) => {
    const other = byPath.get(f.path);
    return !!other && other.sha256 === f.sha256 && other.mode === f.mode;
  });
}
const catalogType = (kind: PackageManifest['kind']) =>
  kind === 'instruction' ? 'instructions' : kind;

export async function syncEntries(deps: {
  cloud: CloudConnector;
  store: JobStore;
  resources: InternalResource[];
  roots: AdapterRoots;
  binding: CloudBinding;
  /** Abort + binding check, run before every backend call. */
  check: () => void;
}): Promise<SyncEntry[]> {
  const { cloud, store, resources, roots, binding, check } = deps;
  const key = (catalogId: string) => JSON.stringify([accountKey(binding), catalogId]);

  const heads = new Map<string, ResourceVersion>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    check();
    const data = PAGE.parse(
      await cloud.client.request(
        'GET',
        '/v1/resources?limit=100' + (cursor ? `&cursor=${cursor}` : ''),
      ),
    );
    for (const v of data.items) heads.set(v.manifest.resourceId, v);
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  check();
  if (cursor)
    throw new CloudError(
      'package_limit',
      'This account has more than 10,000 cloud resources, more than one sync can list.',
      409,
    );

  // This device's side: catalog resources mapped to a cloud resource that is saved or synced.
  const local = new Map<string, { r: InternalResource; synced: number | null }>();
  for (const r of resources) {
    const id = store.get<string>('resource-id', key(r.summary.id));
    if (!id || local.has(id)) continue;
    const published = store.get<Published>('published', key(r.summary.id));
    const synced = published?.resourceId === id ? published.version : null;
    // A review that was never saved leaves only an id behind: that resource does not sync.
    if (synced === null && !heads.has(id)) continue;
    local.set(id, { r, synced });
  }

  async function localFiles(r: InternalResource) {
    const blocker = cloudPublicationBlocker(r.summary);
    if (blocker) throw new Error(blocker);
    const project =
      r.summary.scope === 'project' && r.summary.projectId
        ? store.project(binding, r.summary.projectId)
        : null;
    if (r.summary.scope === 'project' && !project)
      throw new Error("Its project isn't linked to a cloud project on this device.");
    return portableFiles(r, await readPublicationPacket(r), roots, project?.path);
  }
  const record = (catalogId: string, resourceId: string, version: number) => {
    store.put('resource-id', key(catalogId), resourceId);
    store.put('published', key(catalogId), { resourceId, version } satisfies Published);
  };
  function itemFrom(
    m: Pick<PackageManifest, 'resourceId' | 'name' | 'agent' | 'kind' | 'scope'>,
    fields: Pick<SyncItem, 'state' | 'cloudVersion' | 'syncedVersion' | 'catalogId'> & {
      reason?: string;
    },
  ): SyncItem {
    return {
      resourceId: m.resourceId,
      name: m.name,
      agent: m.agent,
      kind: m.kind,
      scope: m.scope,
      memory: m.kind === 'memory',
      ...fields,
    };
  }

  /** A cloud resource this device already syncs. */
  async function compare(
    mine: { r: InternalResource; synced: number | null },
    head: ResourceVersion,
  ): Promise<SyncEntry> {
    const m = head.manifest,
      catalogId = mine.r.summary.id;
    const entry = (state: SyncItem['state'], syncedVersion = mine.synced, reason?: string) => ({
      item: itemFrom(m, {
        state,
        catalogId,
        cloudVersion: head.version,
        syncedVersion,
        ...(reason ? { reason } : {}),
      }),
      catalogId,
      head,
    });
    let files: PackageManifest['files'];
    try {
      files = await localFiles(mine.r);
    } catch (error) {
      return entry('blocked', mine.synced, reasonOf(error));
    }
    if (sameFiles(files, m.files)) {
      if (mine.synced !== head.version) record(catalogId, m.resourceId, head.version);
      return entry('synced', head.version);
    }
    if (mine.synced === head.version) return entry('local-changed');
    if (mine.synced === null) return entry('conflict');
    // The cloud moved on. Did this device change since its last sync?
    check();
    let base: ResourceVersion;
    try {
      base = validatedVersion(
        await cloud.client.request('GET', `/v1/resources/${m.resourceId}/versions/${mine.synced}`),
        { resourceId: m.resourceId, version: mine.synced },
      );
    } catch (error) {
      if (error instanceof CloudError && error.code === 'not_found') return entry('conflict');
      throw error;
    }
    return entry(sameFiles(files, base.manifest.files) ? 'cloud-newer' : 'conflict');
  }

  /** A cloud resource this device doesn't sync yet: is its place free, a copy, or another file? */
  async function unclaimed(head: ResourceVersion): Promise<SyncEntry> {
    const m = head.manifest;
    const entry = (
      state: SyncItem['state'],
      catalogId: string | null = null,
      reason?: string,
      syncedVersion: number | null = null,
    ): SyncEntry => ({
      item: itemFrom(m, {
        state,
        catalogId,
        cloudVersion: head.version,
        syncedVersion,
        ...(reason ? { reason } : {}),
      }),
      catalogId,
      head,
    });
    let projectPath: string | undefined;
    if (m.scope === 'project') {
      const mapping = store.projectsFor(binding).find((p) => p.cloudProjectId === m.projectId);
      if (!mapping)
        return entry(
          'blocked',
          null,
          "Its project isn't on this device yet. Clone it in Projects first.",
        );
      projectPath = mapping.path;
    }
    let path: string;
    try {
      path = resourceDestination(m, roots, projectPath).path;
    } catch (error) {
      return entry('blocked', null, reasonOf(error));
    }
    const there = resources.find(
      (r) =>
        r.entry.absPath === path &&
        r.summary.agent === m.agent &&
        r.summary.scope === m.scope &&
        r.summary.type === catalogType(m.kind),
    );
    if (!there) {
      const taken = await lstat(path).then(
        () => true,
        () => false,
      );
      return taken
        ? entry('blocked', null, 'Something else is already at this location on this device.')
        : entry('cloud-only');
    }
    const claimed = store.get<string>('resource-id', key(there.summary.id));
    if (claimed && claimed !== m.resourceId && local.has(claimed))
      return entry(
        'blocked',
        null,
        'This location already syncs another cloud copy with the same name.',
      );
    let files: PackageManifest['files'];
    try {
      files = await localFiles(there);
    } catch (error) {
      return entry('blocked', there.summary.id, reasonOf(error));
    }
    if (!sameFiles(files, m.files)) return entry('conflict', there.summary.id);
    record(there.summary.id, m.resourceId, head.version);
    local.set(m.resourceId, { r: there, synced: head.version });
    return entry('synced', there.summary.id, undefined, head.version);
  }

  const stopped = new Set(
    store.valuesFor<SyncStopMark>('sync-stopped', binding).map((mark) => mark.resourceId),
  );
  const entries: SyncEntry[] = [];
  for (const [id, head] of heads) {
    const mine = local.get(id);
    if (stopped.has(id)) {
      // Stopped on this device: shown, never compared or moved (no file is read for it).
      const catalogId = mine?.r.summary.id ?? null;
      entries.push({
        item: itemFrom(head.manifest, {
          state: 'stopped',
          catalogId,
          cloudVersion: head.version,
          syncedVersion: mine?.synced ?? null,
        }),
        catalogId,
        head,
      });
      continue;
    }
    entries.push(await (mine ? compare(mine, head) : unclaimed(head)));
  }
  // Synced here, but the cloud has no version of it left: someone removed it from the cloud. It
  // stays as it is on this device and is never uploaded again (that would undo the removal).
  for (const [id, mine] of local)
    if (!heads.has(id) && mine.synced !== null) {
      const s = mine.r.summary;
      entries.push({
        item: itemFrom(
          {
            resourceId: id,
            name: s.name,
            agent: s.agent,
            kind: s.type === 'instructions' ? 'instruction' : (s.type as PackageManifest['kind']),
            scope: s.scope,
          },
          { state: 'removed', catalogId: s.id, cloudVersion: null, syncedVersion: mine.synced },
        ),
        catalogId: s.id,
        head: null,
      });
    }
  return entries.sort(
    (a, b) =>
      a.item.name.localeCompare(b.item.name) || a.item.resourceId.localeCompare(b.item.resourceId),
  );
}
