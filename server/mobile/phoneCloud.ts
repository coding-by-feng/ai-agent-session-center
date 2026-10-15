// phoneCloud.ts — a phone's read-only view of AASC Cloud, through the Mac (AASC-51).
//
// A phone holds no cloud credential that reads resources or projects (its own
// backend token is push only: PHONE_BACKEND_SCOPES), and every desktop cloud
// route sits behind the RESOURCES local gate. So the Mac reads the account's
// cloud for it, with its own connection, and answers three GETs:
//
//   GET /api/phone-cloud/status                   connected or not, last sync, the
//                                                 problem in plain words; no backend call
//   GET /api/phone-cloud/browse[?refresh=1]       resources (each at its current version)
//                                                 and project records
//   GET /api/phone-cloud/resources/:id/versions   a resource's latest versions, newest
//                                                 first. The backend has no version list:
//                                                 each is one exact read, so at most
//                                                 PHONE_CLOUD_VERSIONS_LIMIT of them
//
// What leaves the Mac is the narrowest useful shape: names (a file name, never a
// path inside a project), kinds, versions, dates, sizes and file counts, and a
// project's GitHub owner, repository name and default branch. Never a file path,
// a hash, a description, a project's resource pins, the backend origin, the
// account or device id, a token, or the connector's own error text (problems are
// AASC's fixed words). Nothing here writes.
//
// Reads are kept a minute per account (backend, account, generation) and shared
// by every caller; a refresh reads again at most every PHONE_CLOUD_REFRESH_MIN_MS;
// after a failed read the next waits PHONE_CLOUD_FAILURE_COOLDOWN_MS. Each backend
// request is charged before it is sent, so a listing that pages 20 times costs 20:
// at most PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE listing pages, and on their own
// budget PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE version reads (one per version),
// reach the backend in a minute. A read the budget stops, before or part-way, keeps
// nothing it read and is no failure: the last answer comes back (or 429 when there
// is none). A saved connection nothing has checked since the Mac started
// ('offline', no error) is read too: opening the phone's Cloud screen is the user asking.

import { Router, type Response } from 'express';
import { z } from 'zod';
import { CanonicalCloudIdSchema, ResourceVersionSchema, type ResourceVersion } from '../../src/types/cloudResources.js';
import { ProjectRecordSchema } from '../../src/types/cloudProjects.js';
import type { CloudConnector } from '../cloud/types.js';
import { cloudIdentity, createCloudReadLog, readFailureCode, type CloudReadLog } from './cloudReadLog.js';

export type PhoneCloudState = 'not-connected' | 'unchecked' | 'connected' | 'offline' | 'revoked';

export interface PhoneCloudStatus {
  /** This Mac has a cloud connection it can use: saved, and not revoked. */
  connected: boolean;
  state: PhoneCloudState;
  /** The last read that reached AASC Cloud for a phone (ISO), or null. */
  lastSyncAt: string | null;
  /** What went wrong, in AASC's own words; null when nothing did. */
  problem: string | null;
}

type Manifest = ResourceVersion['manifest'];

export interface PhoneCloudResource {
  id: string;
  name: string;
  kind: Manifest['kind'];
  agent: Manifest['agent'];
  scope: Manifest['scope'];
  /** The current (latest surviving) version. */
  version: number;
  updatedAt: string;
  bytes: number;
  files: number;
}

export interface PhoneCloudProject {
  id: string;
  name: string;
  host: 'github.com';
  owner: string;
  repo: string;
  /** The project's default branch. */
  branch: string;
  /** How many resources the project pins. */
  resources: number;
}

export interface PhoneCloudVersion {
  version: number;
  createdAt: string;
  bytes: number;
  files: number;
}

export interface PhoneCloudBrowse extends PhoneCloudStatus {
  resources: PhoneCloudResource[];
  projects: PhoneCloudProject[];
  /** More than one answer carries: the phone says so. */
  truncated: boolean;
}

export interface PhoneCloudVersions extends PhoneCloudStatus {
  /** Null when the resource is not in the account's listing (any more). */
  resource: PhoneCloudResource | null;
  versions: PhoneCloudVersion[];
  /** Older versions may exist beyond the ones read. */
  truncated: boolean;
}

export const PHONE_CLOUD_TTL_MS = 60_000;
export const PHONE_CLOUD_REFRESH_MIN_MS = 10_000;
export const PHONE_CLOUD_FAILURE_COOLDOWN_MS = 15_000;
/** Listing pages a minute: a typical listing is 2, the largest (MAX_PAGES of each) 20. */
export const PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE = 40;
/** Version reads a minute: a resource's history is up to PHONE_CLOUD_VERSIONS_LIMIT of them. */
export const PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE = 60;
export const PHONE_CLOUD_VERSIONS_LIMIT = 10;
const PAGE_SIZE = 100;
/** Pages per listing: 1,000 resources or projects at most. */
const MAX_PAGES = 10;
const VERSION_READS_AT_ONCE = 5;
const VERSION_CACHE_MAX = 64;
const BUDGET_WINDOW_MS = 60_000;
const BUDGETS = { list: PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE, versions: PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE } as const;
type BudgetKind = keyof typeof BUDGETS;

/** Every problem a phone can be told. Nothing else crosses. */
export const PHONE_CLOUD_PROBLEMS = {
  revoked: 'This Mac’s cloud device was revoked. Connect it again on your Mac: RESOURCES → Cloud → Connection.',
  forbidden: 'AASC Cloud doesn’t let this Mac read resources and projects. Check its device on your Mac: RESOURCES → Cloud.',
  offline: 'Your Mac can’t reach AASC Cloud right now. Check its internet connection, then try again.',
  busy: 'AASC Cloud asked your Mac to slow down. Try again in a minute.',
  slow: 'AASC Cloud took too long to answer. Try again.',
  backend: 'AASC Cloud answered with an error. Try again later.',
  changing: 'Your Mac’s cloud connection is changing. Try again in a moment.',
} as const;

export function phoneCloudProblem(code: string): string {
  switch (code) {
    case 'revoked': return PHONE_CLOUD_PROBLEMS.revoked;
    case 'forbidden': return PHONE_CLOUD_PROBLEMS.forbidden;
    case 'rate_limited': return PHONE_CLOUD_PROBLEMS.busy;
    case 'cancelled': return PHONE_CLOUD_PROBLEMS.slow;
    case 'connection_changing':
    case 'connection_changed': return PHONE_CLOUD_PROBLEMS.changing;
    case 'backend_error':
    case 'invalid_response':
    case 'redirect_refused':
    case 'invalid_path': return PHONE_CLOUD_PROBLEMS.backend;
    default: return PHONE_CLOUD_PROBLEMS.offline;
  }
}

/** Over the per-minute budget with nothing read before to answer from. */
export class PhoneCloudBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many cloud reads in the last minute');
  }
}

export interface PhoneCloudDeps {
  cloud: CloudConnector | null;
  /** Shared with the skill-note favourites, so "last sync" follows either. */
  reads?: CloudReadLog;
  now?: () => number;
  ttlMs?: number;
}

export interface PhoneCloud {
  status(): PhoneCloudStatus;
  browse(options?: { refresh?: boolean }): Promise<PhoneCloudBrowse>;
  versions(resourceId: string): Promise<PhoneCloudVersions>;
}

interface Listing {
  resources: PhoneCloudResource[];
  projects: PhoneCloudProject[];
  truncated: boolean;
}

interface VersionList {
  versions: PhoneCloudVersion[];
  truncated: boolean;
}

const PageSchema = z.object({ items: z.array(z.unknown()).max(PAGE_SIZE), nextCursor: z.uuid().nullable() });

const NOT_CONNECTED: PhoneCloudStatus = Object.freeze({ connected: false, state: 'not-connected', lastSyncAt: null, problem: null });

const sizeOf = (files: Manifest['files']) => ({ bytes: files.reduce((n, f) => n + f.bytes, 0), files: files.length });

/**
 * A name's last path segment. A nested instruction file is named by its path
 * inside its project (`packages/api/CLAUDE.md`), and no path leaves the Mac:
 * the phone gets `CLAUDE.md`, and kind and scope say the rest.
 */
function phoneName(m: Manifest): string {
  return m.name.split(/[/\\]/).map((s) => s.trim()).filter(Boolean).at(-1) ?? m.kind;
}

function toResource(raw: unknown): PhoneCloudResource | null {
  const parsed = ResourceVersionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { manifest: m, version, createdAt } = parsed.data;
  return { id: m.resourceId, name: phoneName(m), kind: m.kind, agent: m.agent, scope: m.scope, version, updatedAt: createdAt, ...sizeOf(m.files) };
}

function toProject(raw: unknown): PhoneCloudProject | null {
  const parsed = ProjectRecordSchema.safeParse(raw);
  if (!parsed.success || parsed.data.deleted) return null;
  const { id, name, repository, resources } = parsed.data;
  return { id, name, host: 'github.com', owner: repository.owner, repo: repository.name, branch: repository.branch, resources: resources.length };
}

const failed = (code: string) => Object.assign(new Error(code), { code });

/** A read the per-minute budget stopped, or null. */
type Stopped = PhoneCloudBusyError | null;

export function createPhoneCloud(deps: PhoneCloudDeps): PhoneCloud {
  const { cloud } = deps;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? PHONE_CLOUD_TTL_MS;
  const reads = deps.reads ?? createCloudReadLog(now);
  let listing: { identity: string; at: number; value: Listing } | null = null;
  let listingInflight: { identity: string; promise: Promise<Stopped> } | null = null;
  const versionCache = new Map<string, { at: number; value: VersionList }>();
  const versionInflight = new Map<string, Promise<Stopped>>();
  let budgets: Record<BudgetKind, { start: number; used: number }> = { list: { start: 0, used: 0 }, versions: { start: 0, used: 0 } };

  const identityNow = (): string | null => cloudIdentity(cloud?.status().connection);
  /** The account to read, or null when nothing may be read (no connection, or revoked). */
  const readable = (): string | null => {
    const s = cloud?.status();
    return s && s.state !== 'revoked' && s.state !== 'disconnected' ? cloudIdentity(s.connection) : null;
  };

  function status(): PhoneCloudStatus {
    const s = cloud?.status();
    const identity = cloudIdentity(s?.connection);
    if (!s || !identity) return NOT_CONNECTED;
    const view = reads.view(identity);
    const lastSyncAt = view.lastSuccessAt === null ? null : new Date(view.lastSuccessAt).toISOString();
    if (s.state === 'revoked') return { connected: false, state: 'revoked', lastSyncAt, problem: PHONE_CLOUD_PROBLEMS.revoked };
    if (s.state === 'disconnected') return NOT_CONNECTED;
    const problem = view.failure ? phoneCloudProblem(view.failure.code) : s.state === 'offline' && s.lastError ? PHONE_CLOUD_PROBLEMS.offline : null;
    const state = s.state === 'connected' ? 'connected' : s.lastError || view.failure ? 'offline' : 'unchecked';
    return { connected: true, state, lastSyncAt, problem };
  }

  /** 0 while `kind` has a backend request left this minute, else seconds until its window restarts. */
  function budgetWait(kind: BudgetKind): number {
    const t = now();
    if (t - budgets[kind].start >= BUDGET_WINDOW_MS) budgets = { ...budgets, [kind]: { start: t, used: 0 } };
    const { start, used } = budgets[kind];
    return used < BUDGETS[kind] ? 0 : Math.max(1, Math.ceil((start + BUDGET_WINDOW_MS - t) / 1000));
  }

  /** One backend GET, charged to `kind`'s budget before it is sent. */
  async function request(kind: BudgetKind, path: string): Promise<unknown> {
    if (!cloud) throw failed('disconnected');
    const wait = budgetWait(kind);
    if (wait > 0) throw new PhoneCloudBusyError(wait);
    budgets = { ...budgets, [kind]: { ...budgets[kind], used: budgets[kind].used + 1 } };
    return cloud.client.request<unknown>('GET', path);
  }

  function coolingDown(identity: string, refresh: boolean): boolean {
    const failure = reads.view(identity).failure;
    return !!failure && now() - failure.at < (refresh ? PHONE_CLOUD_REFRESH_MIN_MS : PHONE_CLOUD_FAILURE_COOLDOWN_MS);
  }

  /**
   * Run a read; the log learns how it went, for this account only. A read the
   * budget stopped is no failure: it comes back, for callers with no answer.
   */
  async function logged(identity: string, work: () => Promise<void>): Promise<Stopped> {
    try {
      await work();
      if (identityNow() === identity) reads.succeeded(identity);
    } catch (err) {
      if (err instanceof PhoneCloudBusyError) return err;
      if (identityNow() === identity) reads.failed(identity, readFailureCode(err));
    }
    return null;
  }

  /** What a read leaves to answer with; nothing at all after a budget stop is a 429. */
  function settled<T>(value: T | null, stopped: Stopped): T | null {
    if (value === null && stopped) throw stopped;
    return value;
  }

  async function pullPages<T>(path: string, map: (raw: unknown) => T | null): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await request('list', `${path}?limit=${PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ''}`);
      const parsed = PageSchema.safeParse(raw);
      if (!parsed.success) throw failed('invalid_response');
      for (const item of parsed.data.items) {
        const mapped = map(item);
        if (mapped) items.push(mapped);
      }
      const next = parsed.data.nextCursor;
      if (!next) return { items, truncated: false };
      if (seen.has(next)) throw failed('invalid_response');
      seen.add(next);
      cursor = next;
    }
    return { items, truncated: true };
  }

  async function loadListing(identity: string, refresh: boolean): Promise<Listing | null> {
    const cached = listing?.identity === identity ? listing : null;
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < ttl && !(refresh && age >= PHONE_CLOUD_REFRESH_MIN_MS)) return cached.value;
    if (listingInflight?.identity === identity) {
      const stopped = await listingInflight.promise;
      return settled(listing?.identity === identity ? listing.value : null, stopped);
    }
    if (coolingDown(identity, refresh)) return cached?.value ?? null;
    const wait = budgetWait('list');
    if (wait > 0) {
      if (cached) return cached.value;
      throw new PhoneCloudBusyError(wait);
    }
    const promise = logged(identity, async () => {
      const [resources, projects] = await Promise.all([
        pullPages('/v1/resources', toResource),
        pullPages('/v1/projects', toProject),
      ]);
      if (identityNow() !== identity) return;
      listing = {
        identity,
        at: now(),
        value: {
          resources: [...resources.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name)),
          projects: [...projects.items].sort((a, b) => a.name.localeCompare(b.name)),
          truncated: resources.truncated || projects.truncated,
        },
      };
    }).finally(() => {
      if (listingInflight?.promise === promise) listingInflight = null;
    });
    listingInflight = { identity, promise };
    const stopped = await promise;
    return settled(listing?.identity === identity ? listing.value : cached?.value ?? null, stopped);
  }

  async function readVersion(id: string, version: number): Promise<PhoneCloudVersion | null> {
    try {
      const parsed = ResourceVersionSchema.safeParse(await request('versions', `/v1/resources/${id}/versions/${version}`));
      if (!parsed.success || parsed.data.manifest.resourceId !== id || parsed.data.version !== version) return null;
      return { version, createdAt: parsed.data.createdAt, ...sizeOf(parsed.data.manifest.files) };
    } catch (err) {
      if (readFailureCode(err) === 'not_found') return null; // that version was deleted
      throw err;
    }
  }

  async function pullVersions(resource: PhoneCloudResource): Promise<VersionList> {
    const wanted: number[] = [];
    for (let v = resource.version; v >= 1 && wanted.length < PHONE_CLOUD_VERSIONS_LIMIT; v--) wanted.push(v);
    const versions: PhoneCloudVersion[] = [];
    for (let i = 0; i < wanted.length; i += VERSION_READS_AT_ONCE) {
      const batch = await Promise.all(wanted.slice(i, i + VERSION_READS_AT_ONCE).map((v) => readVersion(resource.id, v)));
      for (const item of batch) if (item) versions.push(item);
    }
    return { versions, truncated: resource.version > PHONE_CLOUD_VERSIONS_LIMIT };
  }

  async function loadVersions(identity: string, resource: PhoneCloudResource): Promise<VersionList | null> {
    const key = JSON.stringify([identity, resource.id, resource.version]);
    const cached = versionCache.get(key);
    if (cached && now() - cached.at < ttl) return cached.value;
    const inflight = versionInflight.get(key);
    if (inflight) {
      const stopped = await inflight;
      return settled(versionCache.get(key)?.value ?? null, stopped);
    }
    if (coolingDown(identity, false)) return cached?.value ?? null;
    const wait = budgetWait('versions');
    if (wait > 0) {
      if (cached) return cached.value;
      throw new PhoneCloudBusyError(wait);
    }
    const promise = logged(identity, async () => {
      const value = await pullVersions(resource);
      if (identityNow() !== identity) return;
      versionCache.delete(key);
      if (versionCache.size >= VERSION_CACHE_MAX) versionCache.delete(versionCache.keys().next().value as string);
      versionCache.set(key, { at: now(), value });
    }).finally(() => versionInflight.delete(key));
    versionInflight.set(key, promise);
    const stopped = await promise;
    return settled(versionCache.get(key)?.value ?? cached?.value ?? null, stopped);
  }

  return {
    status,

    async browse(options = {}) {
      const identity = readable();
      const value = identity ? await loadListing(identity, options.refresh === true) : null;
      return { ...status(), resources: value?.resources ?? [], projects: value?.projects ?? [], truncated: value?.truncated ?? false };
    },

    async versions(resourceId) {
      const identity = readable();
      const resource = identity ? (await loadListing(identity, false))?.resources.find((r) => r.id === resourceId) ?? null : null;
      const value = identity && resource ? await loadVersions(identity, resource) : null;
      return { ...status(), resource, versions: value?.versions ?? [], truncated: value?.truncated ?? false };
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const NoQuery = z.object({}).strict();
const BrowseQuery = z.object({ refresh: z.literal('1').optional() }).strict();

function refuse(res: Response): void {
  res.status(400).json({ error: 'Invalid request' });
}

async function answer<T>(res: Response, read: () => Promise<T>, fallback: () => T): Promise<void> {
  try {
    res.json(await read());
  } catch (err) {
    if (err instanceof PhoneCloudBusyError) {
      res.status(429).json({
        error: 'AASC Cloud was read a lot in the last minute. Try again in a moment.',
        code: 'PHONE_CLOUD_LIMIT',
        retryAfter: err.retryAfterSeconds,
      });
      return;
    }
    // Never an error page: whatever went wrong, the phone gets the state and empty lists.
    res.json(fallback());
  }
}

/**
 * The three GETs. Mounted inside `/api`, after authMiddleware and the phone
 * profile (which opens exactly these GETs to paired phones); every other method
 * or sub-path falls through to the API router's 404.
 */
export function createPhoneCloudRouter(phoneCloud: PhoneCloud): Router {
  const router = Router();
  router.use('/phone-cloud', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/phone-cloud/status', (req, res) => {
    if (!NoQuery.safeParse(req.query).success) return refuse(res);
    res.json(phoneCloud.status());
  });
  router.get('/phone-cloud/browse', async (req, res) => {
    const query = BrowseQuery.safeParse(req.query);
    if (!query.success) return refuse(res);
    await answer(
      res,
      () => phoneCloud.browse({ refresh: query.data.refresh === '1' }),
      () => ({ ...phoneCloud.status(), resources: [], projects: [], truncated: false }),
    );
  });
  router.get('/phone-cloud/resources/:id/versions', async (req, res) => {
    const id = CanonicalCloudIdSchema.safeParse(req.params.id);
    if (!id.success || !NoQuery.safeParse(req.query).success) return refuse(res);
    await answer(
      res,
      () => phoneCloud.versions(id.data),
      () => ({ ...phoneCloud.status(), resource: null, versions: [], truncated: false }),
    );
  });
  return router;
}
