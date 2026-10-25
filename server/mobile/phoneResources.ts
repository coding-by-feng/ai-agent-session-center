// phoneResources.ts — the RESOURCES tab on a paired phone (Oct 24 2026, plan 16): the desktop's
// Library, Cloud sync and Projects, read through the same server objects the desktop uses — the
// catalog `/api/resources` scans, `resourceUsage`, and the cloud's resource and project jobs — so
// both show the same states. `/api/resources/*` itself stays Mac-only; this is the phone's way in.
//
// What a phone may see (phoneResourceRedact.ts holds the rules):
// - **Project resources follow the shared-project rule** of `/commands` and the project files: a
//   resource filed under a project (its skills, instructions, memory) only when a session in that
//   project is shared with remote devices. Global ones always. A hidden one reads as missing.
// - **No closed path inside a visible resource**: config keys and values naming another project
//   are dropped or masked, findings and symlink targets left out, sync rows named by their last
//   segment.
// - **Use counts cover only the shared sessions** (decision 3); a request from the Mac itself
//   counts every session and sees every project, like the desktop.
// - **Paths are display paths** (`~/…`), config values masked by the catalog, as on the desktop.
// - **Cloud sync waits for a scan**: the sync status compares the scanned Library with the cloud,
//   so while the Mac scans the phone is told so (and keeps its last list), never "offline".
// - **Cloud and git are read at most every PHONE_RESOURCES_REFRESH_MIN_MS** and kept
//   PHONE_RESOURCES_TTL_MS, so a phone can't make the Mac hammer AASC Cloud or run git in a loop.
//   A failed read keeps the last answer and says what went wrong in AASC's fixed words.
//
// P1 reads only. The writes (plan 16, P2 and P3) come later.

import { homedir } from 'os';
import { isAbsolute, relative, resolve, sep } from 'path';
import { ResourceLookupError, type ResourceCatalogService } from '../resourceCatalog.js';
import { USAGE_WINDOW_DAYS, usageById, type ResourceUsageCounter } from '../resourceUsage.js';
import type { ResourceJobs } from '../cloud/resourceJobs.js';
import type { ProjectJobs } from '../cloud/projectJobs.js';
import type { CloudBinding } from '../cloud/binding.js';
import type { CloudConnector } from '../cloud/types.js';
import type { GithubAccounts, ProjectRecord } from '../../src/types/cloudProjects.js';
import type { ResourceCatalog, ResourceDetail, ResourceFileContent, ResourceSummary } from '../../src/types/resources.js';
import type {
  PhoneCloudLink, PhoneLibrary, PhoneProject, PhoneProjectLocal, PhoneProjects, PhoneSync,
} from '../../src/types/phoneResources.js';
import { phoneCloudProblem } from './phoneCloud.js';
import {
  createOpenProjects, openPathGate, redactDetail, redactSummary, redactSyncItem, visibleWith, type PhoneViewer,
} from './phoneResourceRedact.js';
import { cloudIdentity, readFailureCode } from './cloudReadLog.js';

export const PHONE_RESOURCES_TTL_MS = 60_000;
export const PHONE_RESOURCES_REFRESH_MIN_MS = 10_000;
/** Projects one answer carries; their local state is one git inspection each. */
export const PHONE_PROJECTS_LIMIT = 200;
const PROJECT_PAGES = 10;
const LOCAL_READS_AT_ONCE = 4;

export type { PhoneViewer };

/** Said while the Mac scans: the sync status needs the scanned Library. */
export const PHONE_RESOURCES_SCANNING = 'Your Mac is reading its resources. Try again in a moment.';
const SCANNING_CODE = 'catalog_scanning';

export interface PhoneResourcesDeps {
  /** The RESOURCES tab's own catalog (resourceRouter's `onCatalogReady`); null until mounted. */
  catalog: () => ResourceCatalogService | null;
  usage: ResourceUsageCounter;
  /** Sessions shared with remote devices right now. */
  sharedSessionIds: () => string[];
  /** Their (local) project folders. */
  sharedProjectPaths: () => string[];
  cloud: CloudConnector | null;
  /** The cloud's resource and project jobs (resourceRouter's ready hooks); null without a connector. */
  cloudJobs: () => Promise<ResourceJobs> | null;
  cloudProjects: () => Promise<ProjectJobs> | null;
  home?: string;
  now?: () => number;
}

export interface PhoneResources {
  library(viewer: PhoneViewer): PhoneLibrary;
  /** Null when there is no such resource, or the viewer may not see it. */
  item(viewer: PhoneViewer, id: string): Promise<ResourceDetail | null>;
  /** Null when hidden; the catalog's own errors (a bad path) are thrown as on the desktop. */
  file(viewer: PhoneViewer, id: string, path: string): Promise<ResourceFileContent | null>;
  sync(viewer: PhoneViewer, options?: { refresh?: boolean }): Promise<PhoneSync>;
  projects(options?: { refresh?: boolean }): Promise<PhoneProjects>;
}

const EMPTY_ACCOUNTS: GithubAccounts = Object.freeze({ installed: false, accounts: [] });

/** A path on this Mac as the desktop shows it: `~/…` under home, else its last segment. */
export function displayPath(path: string, home: string): string {
  const rel = relative(resolve(home), resolve(path));
  if (rel === '') return '~';
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) return `~/${rel.split(sep).join('/')}`;
  return resolve(path).split(sep).filter(Boolean).at(-1) ?? '';
}

/** One answer per account, read again at most every minRefreshMs; a failure keeps the last one. */
function createKeptRead<T>(now: () => number) {
  let kept: { identity: string; at: number; value: T } | null = null;
  let failure: { identity: string; at: number; code: string } | null = null;
  let inflight: { identity: string; promise: Promise<void> } | null = null;
  const answer = (identity: string) => ({
    value: kept?.identity === identity ? kept.value : null,
    at: kept?.identity === identity ? kept.at : null,
    failure: failure?.identity === identity ? failure.code : null,
  });
  async function read(identity: string, refresh: boolean, load: () => Promise<T>) {
    const t = now();
    const mine = kept?.identity === identity ? kept : null;
    const age = mine ? t - mine.at : Infinity;
    if (mine && age < PHONE_RESOURCES_TTL_MS && !(refresh && age >= PHONE_RESOURCES_REFRESH_MIN_MS)) return answer(identity);
    if (inflight?.identity === identity) {
      await inflight.promise;
      return answer(identity);
    }
    if (failure?.identity === identity && t - failure.at < PHONE_RESOURCES_REFRESH_MIN_MS) return answer(identity);
    const promise = load().then(
      (value) => {
        kept = { identity, at: now(), value };
        if (failure?.identity === identity) failure = null;
      },
      (err: unknown) => {
        failure = { identity, at: now(), code: readFailureCode(err) };
      },
    ).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { identity, promise };
    await promise;
    return answer(identity);
  }
  /** The last answer for this account, without reading. */
  return { read, peek: answer };
}

export function createPhoneResources(deps: PhoneResourcesDeps): PhoneResources {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const keptSync = createKeptRead<PhoneSync['items']>(now);
  const keptProjects = createKeptRead<Omit<PhoneProjects, keyof PhoneCloudLink>>(now);

  const openProjects = createOpenProjects(now);
  const openFor = (viewer: PhoneViewer, catalog: ResourceCatalog): ReadonlySet<string> =>
    viewer.local ? new Set() : openProjects(catalog, deps.sharedProjectPaths(), home);
  const filterFor = (viewer: PhoneViewer, catalog: ResourceCatalog) => visibleWith(viewer, openFor(viewer, catalog));

  /** The current scan and the resource, if the viewer may see it. */
  function visibleResource(viewer: PhoneViewer, id: string): { catalog: ResourceCatalog; resource: ResourceSummary } | null {
    const catalog = deps.catalog()?.getCatalog();
    const resource = catalog?.resources.find((r) => r.id === id) ?? null;
    return resource && catalog && filterFor(viewer, catalog)(resource) ? { catalog, resource } : null;
  }

  /** The kept sync rows the viewer may see, each as a phone sees it. */
  function syncItemsFor(viewer: PhoneViewer, rows: PhoneSync['items']): PhoneSync['items'] {
    const catalog = deps.catalog()?.getCatalog();
    if (viewer.local) return rows;
    const visible = catalog ? filterFor(viewer, catalog) : () => false;
    const byId = new Map((catalog?.resources ?? []).map((r) => [r.id, r]));
    // A local resource the viewer may not see is left out; one only in the cloud shows, as in More → Cloud.
    return rows.flatMap((i) => {
      const resource = i.catalogId ? byId.get(i.catalogId) : undefined;
      if (i.catalogId && !(resource ? visible(resource) : i.scope === 'global')) return [];
      return [redactSyncItem(i, !!resource && visible(resource))];
    });
  }

  /** The connection to read with, or null with the state that says why not. */
  function link(): { binding: CloudBinding | null; identity: string | null; base: Omit<PhoneCloudLink, 'problem' | 'readAt'> } {
    const s = deps.cloud?.status();
    const c = s?.connection;
    if (!s || !c || s.state === 'disconnected') return { binding: null, identity: null, base: { connected: false, state: 'not-connected' } };
    if (s.state === 'revoked') return { binding: null, identity: null, base: { connected: false, state: 'revoked' } };
    const state = s.state === 'connected' ? 'connected' : s.lastError ? 'offline' : 'unchecked';
    return {
      binding: { backendOrigin: c.backendOrigin, accountId: c.accountId, generation: c.generation },
      identity: cloudIdentity(c),
      base: { connected: true, state },
    };
  }

  function linkWords(base: Omit<PhoneCloudLink, 'problem' | 'readAt'>, failure: string | null, at: number | null): PhoneCloudLink {
    const problem = base.state === 'revoked'
      ? phoneCloudProblem('revoked')
      : failure === SCANNING_CODE ? PHONE_RESOURCES_SCANNING : failure ? phoneCloudProblem(failure) : null;
    return { ...base, problem, readAt: at === null ? null : new Date(at).toISOString() };
  }

  async function localOf(jobs: ProjectJobs, id: string, binding: CloudBinding): Promise<PhoneProjectLocal | null> {
    try {
      const local = await jobs.localProject(id, binding);
      return {
        state: local.state,
        branch: local.branch,
        path: local.path === null ? null : displayPath(local.path, home),
        ahead: local.ahead,
        behind: local.behind,
        account: local.account,
      };
    } catch {
      return null;
    }
  }

  async function readProjects(binding: CloudBinding) {
    const jobs = await deps.cloudProjects();
    if (!jobs) throw Object.assign(new Error('no project service'), { code: 'offline' });
    const records: ProjectRecord[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < PROJECT_PAGES; page++) {
      const answer = await jobs.listProjects({ limit: 100, ...(cursor ? { cursor } : {}) }, binding);
      records.push(...answer.items.filter((p) => !p.deleted));
      more = !!answer.nextCursor;
      if (!answer.nextCursor || answer.nextCursor === cursor) break;
      cursor = answer.nextCursor;
    }
    const shown = records.sort((a, b) => a.name.localeCompare(b.name)).slice(0, PHONE_PROJECTS_LIMIT);
    const accounts = await jobs.githubAccounts().catch(() => EMPTY_ACCOUNTS);
    const projects: PhoneProject[] = [];
    for (let i = 0; i < shown.length; i += LOCAL_READS_AT_ONCE) {
      const batch = shown.slice(i, i + LOCAL_READS_AT_ONCE);
      const locals = await Promise.all(batch.map((p) => localOf(jobs, p.id, binding)));
      batch.forEach((p, n) => projects.push({
        id: p.id,
        name: p.name,
        owner: p.repository.owner,
        repo: p.repository.name,
        branch: p.repository.branch,
        local: locals[n],
      }));
    }
    return { accounts, projects, truncated: more || records.length > PHONE_PROJECTS_LIMIT };
  }

  return {
    library(viewer) {
      const service = deps.catalog();
      if (!service) return { state: 'idle', scannedAt: null, resources: [], projects: [], usage: null };
      const catalog = service.getOrStartCatalog();
      const visible = filterFor(viewer, catalog);
      const resources = catalog.resources.filter(visible).map((r) => (viewer.local ? r : redactSummary(r)));
      const projectIds = new Set(resources.map((r) => r.projectId).filter(Boolean));
      const counts = catalog.scannedAt ? deps.usage.counts(viewer.local ? null : deps.sharedSessionIds()) : null;
      return {
        state: catalog.state,
        scannedAt: catalog.scannedAt ?? null,
        resources,
        projects: catalog.projects.filter((p) => projectIds.has(p.id)).map(({ id, name, path }) => ({ id, name, path })),
        usage: counts
          ? { windowDays: USAGE_WINDOW_DAYS, scope: viewer.local ? 'all' : 'shared', byId: usageById(counts, resources) }
          : null,
      };
    },

    async item(viewer, id) {
      const found = visibleResource(viewer, id);
      if (!found) return null;
      const detail = (await deps.catalog()?.getDetail(id)) ?? null;
      if (!detail || viewer.local) return detail;
      return redactDetail(detail, openPathGate(found.catalog, openFor(viewer, found.catalog)));
    },

    async file(viewer, id, path) {
      if (!visibleResource(viewer, id)) return null;
      return (await deps.catalog()?.getFile(id, path)) ?? null;
    },

    async sync(viewer, options = {}) {
      const { binding, identity, base } = link();
      if (!binding || !identity) return { ...linkWords(base, null, null), items: [] };
      // The status compares the scanned Library with the cloud: start a scan as the desktop's tab
      // does, and while it runs say so over the last list instead of reading.
      const catalog = deps.catalog()?.getOrStartCatalog();
      if (catalog?.state !== 'ready' || !catalog.scannedAt) {
        const last = keptSync.peek(identity);
        return { ...linkWords(base, SCANNING_CODE, last.at), items: syncItemsFor(viewer, last.value ?? []) };
      }
      const read = await keptSync.read(identity, options.refresh === true, async () => {
        const jobs = await deps.cloudJobs();
        if (!jobs) throw Object.assign(new Error('no resource service'), { code: 'offline' });
        try {
          return (await jobs.syncStatus(binding)).items;
        } catch (err) {
          // A scan that started under the read: not the cloud's failure.
          if (err instanceof ResourceLookupError) throw Object.assign(new Error('scanning'), { code: SCANNING_CODE });
          throw err;
        }
      });
      return { ...linkWords(base, read.failure, read.at), items: syncItemsFor(viewer, read.value ?? []) };
    },

    async projects(options = {}) {
      const { binding, identity, base } = link();
      const empty = { accounts: EMPTY_ACCOUNTS, projects: [], truncated: false };
      if (!binding || !identity) return { ...linkWords(base, null, null), ...empty };
      const read = await keptProjects.read(identity, options.refresh === true, () => readProjects(binding));
      return { ...linkWords(base, read.failure, read.at), ...(read.value ?? empty) };
    },
  };
}
