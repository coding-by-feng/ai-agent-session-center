/**
 * resourceRouter — `/api/resources`, the local RESOURCES catalog and cloud API.
 *
 * Mounted by the integrator as
 *   app.use('/api/resources', authMiddleware, createResourceRouter({...}))
 *   app.use('/api/resources', resourceErrorHandler)
 *
 * **Local-only, reads included.** The first middleware answers every non-local
 * request with 404 — not 403 — for the same reason `requireVisibleSession`
 * does: a LAN device must not be able to tell "no such route" from "hidden from
 * you". A remote client never sees this machine's skills, MCP servers or
 * settings, and never starts a scan of its disk. "Local" is more than a
 * loopback socket — see `isLocalResourceRequest` (DNS rebinding).
 *
 * The optional cloud connector (`deps.cloud`) mounts under `/cloud` behind the
 * same gate: connection status/actions, skill-notes sync, cloud aliases, cloud
 * resource packages (publish, install, download, restore) and cloud project
 * records. A remote device or a paired phone never reaches any of it. SSH
 * Resource Transfers and Project Sync were retired for the cloud (AASC-51).
 * Remote access (`deps.remoteAccess`, AASC-60) mounts at `/cloud/remote-access`
 * behind the same gate, but needs no cloud connector.
 *
 * Every input is Zod-validated; every answer is `{ success, data | error }`;
 * no route ever sends a stack trace. index.ts parses JSON globally BEFORE this
 * router, so a malformed body fails outside it — where only
 * `resourceErrorHandler`, mounted right after the router, can answer it.
 */
import { Router, json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { homedir } from 'os';
import { isAbsolute, resolve, join } from 'path';
import { z } from 'zod';
import { isLocalRequest } from './requestLocality.js';
import { PathSafetyError } from './fsSafe.js';
import { createResourceCatalog, ResourceLookupError, type ResourceCatalogService } from './resourceCatalog.js';
import { TRASH_ID_RE, TrashError } from './resourceUninstall.js';
import { ABBR_RE, TARGET_RE, AliasError, aliasCatalogRealNames, createAlias, removeAlias } from './resourceAliases.js';
import log from './logger.js';
import { createCloudRouter, type CloudGoogleRoutes } from './cloud/router.js';
import { createNotesRouter, notesErrorHandler } from './cloud/notesRouter.js';
import { createResourceJobs, type ResourceJobs } from './cloud/resourceJobs.js';
import type { ProjectActivity } from './knownProjects.js';
import { createProjectJobs, type ProjectJobs } from './cloud/projectJobs.js';
import { createProjectRouter } from './cloud/projectRouter.js';
import { createResourceJobsRouter } from './cloud/resourceRouter.js';
import { globalRootPaths } from './resourceRoots.js';
import { createCloudAliases, type CloudAliasesService } from './cloud/aliases.js';
import { createCloudAliasesRouter } from './cloud/aliasRouter.js';
import { createRemoteAccessRouter } from './cloud/remoteAccessRouter.js';
import { USAGE_WINDOW_DAYS, usageById, type TokenUse } from './resourceUsage.js';
import type { RemoteAccess } from './cloud/remoteAccess.js';
import type { CloudConnector } from './cloud/types.js';

export interface ResourceRouterDeps {
  /** Optional server-owned cloud connector; the device token never reaches the renderer. */
  cloud?: CloudConnector;
  /** Sign in with Google (AASC-61): POST /cloud/google/start and /cancel. The callback is mounted in index.ts. */
  cloudGoogle?: CloudGoogleRoutes;
  /** Remote access (AASC-60): this Mac's Tailscale state and how its paired phones reach it. Works without `cloud`. */
  remoteAccess?: RemoteAccess;
  /** Private directory for cloud alias state. Required with `cloud`. */
  cloudAliasDirectory?: string;
  /** Private directory for cloud resource/project jobs, caches and install backups. Default `<cloudAliasDirectory>/resources`. */
  cloudJobDirectory?: string;
  onCloudProjectsReady?: (getCloudProjects: () => Promise<ProjectJobs>) => void;
  /** Hands the lazily opened job store to its owner (index.ts opens it before listening, closes it at shutdown). */
  onCloudJobsReady?: (getCloudJobs: () => Promise<ResourceJobs>) => void;
  /** Hands the lazily created cloud alias service to its owner (the verified-install retry in resourceJobs). */
  onCloudAliasesReady?: (getCloudAliases: () => Promise<CloudAliasesService>) => void;
  /** Project paths of sessions AASC knows about → evidence 'aasc-session'. */
  sessionProjectPaths: () => string[];
  /** Projects an agent is working in now (agentWork.ts): Pull and Push wait for them. Default `sessionProjectPaths`. */
  cloudActiveProjectPaths?: () => string[];
  /** Sessions per folder over the last 30 days: RESOURCES → Projects lists folders most used first. */
  projectActivity?: () => readonly ProjectActivity[];
  /** Tests override; default `isLocalResourceRequest`. */
  isLocalRequest?: (req: Request) => boolean;
  /** Tests override the environment and home dir (fixtures). Default process.env / os.homedir(). */
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Where uninstalled resources go. Default `DEFAULT_TRASH_DIR` (resourceUninstall.ts). */
  trashDir?: string;
  /** Skill/command uses in the last 90 days by typed token (resourceUsage.ts); null = unknown. Absent: nothing is counted. */
  usageCounts?: () => ReadonlyMap<string, TokenUse> | null;
  /** Hands the catalog to the phone's Library (server/mobile/phoneResources.ts): one scan for both. */
  onCatalogReady?: (catalog: ResourceCatalogService) => void;
}

/**
 * The default local gate. A loopback SOCKET is not enough on its own: a
 * DNS-rebinding page (`attacker.example`, re-resolved to 127.0.0.1) talks to
 * this server from the user's own browser, so its socket IS loopback and, with
 * no password set, authMiddleware lets it through. What gives it away is the
 * Host it names, its Origin and its Sec-Fetch-Site — all four must pass.
 */
export function isLocalResourceRequest(req: Request): boolean {
  // isLocalRequest now carries the Host / Origin / Sec-Fetch-Site checks this
  // gate introduced (AASC-26), so every local gate shares them.
  return isLocalRequest({ socket: req.socket, headers: req.headers });
}

/**
 * The extra bar for resource WRITE routes (uninstall, restore, aliases and cloud): the request must
 * come from the AASC page itself, not merely from this machine. The local gate
 * above accepts any loopback Origin — a page on another localhost port is local
 * too — and for reads that is fine. For a write, a browser marks a different
 * port `Sec-Fetch-Site: same-site`, so only `same-origin` (or no such header: a
 * non-browser client, which can already touch these files itself) passes.
 * Origin is deliberately not compared with Host: the Vite dev proxy rewrites
 * Host (`changeOrigin`) while the browser still sees one origin. A cross-origin
 * page cannot get this far anyway: the JSON body these routes require forces a
 * CORS preflight, and this server answers none.
 */
export function isSameOriginWrite(req: Request): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  return site === '' || site === 'same-origin';
}

// Express 5 types params/query as string | string[] | …; routes here use single values.
function str(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return String(val[0] ?? '');
  return val != null ? String(val) : '';
}

const MAX_EXTRA_ROOTS = 50;

const resourceIdSchema = z.string().regex(/^[a-f0-9]{16}$/);

const extraRootSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'must not contain a NUL byte')
  .refine((p) => isAbsolute(p), 'must be an absolute path')
  // Counted on the RESOLVED path: '/tmp/..' has two segments as written and is '/'.
  .refine((p) => resolve(p).split(/[\\/]+/).filter(Boolean).length >= 2, 'must have at least 2 path segments');

const scanBodySchema = z.object({
  extraRoots: z.array(extraRootSchema).max(MAX_EXTRA_ROOTS).optional(),
});

const fileQuerySchema = z.object({
  path: z.string().min(1).max(4096).refine((p) => !p.includes('\0'), 'must not contain a NUL byte'),
});

const compareQuerySchema = z.object({
  against: z.union([z.literal('repo'), resourceIdSchema]),
});

const uninstallBodySchema = z.object({
  confirmName: z.string().max(4096),
});

const trashIdSchema = z.string().regex(TRASH_ID_RE);

const aliasBodySchema = z.object({
  agent: z.enum(['claude', 'codex', 'shared']),
  kind: z.enum(['skill', 'command']),
  target: z.string().regex(TARGET_RE),
  abbr: z.string().regex(ABBR_RE),
});
const aliasRemoveSchema = aliasBodySchema.omit({ target: true });

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error });
}

function validate<T>(schema: z.ZodType<T>, input: unknown, res: Response): T | null {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  fail(res, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return null;
}

/** A known lookup/path error becomes its status; anything else is a logged, generic 500. */
function sendError(res: Response, err: unknown, home: string): void {
  if (err instanceof PathSafetyError) return fail(res, err.reason === 'not-found' ? 404 : 400, err.message);
  if (err instanceof ResourceLookupError || err instanceof TrashError || err instanceof AliasError) return fail(res, err.status, err.message);
  const message = err instanceof Error ? err.message : String(err);
  log.warn('resources', `Request failed: ${message.split(home).join('~').slice(0, 300)}`);
  fail(res, 500, 'Internal error');
}

/** Body-parser failures (malformed JSON, oversized body) and anything a handler let escape. */
function respondToError(res: Response, err: unknown, home: string): void {
  // Our own errors first: a ResourceLookupError carries a 4xx `status` too.
  if (err instanceof PathSafetyError || err instanceof ResourceLookupError || err instanceof TrashError || err instanceof AliasError) {
    return sendError(res, err, home);
  }
  const { type, status } = (err ?? {}) as { type?: string; status?: number };
  if (type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON body');
  if (type === 'entity.too.large' || status === 413) return fail(res, 413, 'Request body too large');
  // Any other body-parser rejection (415 charset, 400 aborted…) is the client's error, not ours.
  if (typeof status === 'number' && status >= 400 && status < 500) return fail(res, status, 'Invalid request body');
  sendError(res, err, home);
}

/**
 * Error handler for the `/api/resources` prefix — mount it right after the
 * router: `app.use('/api/resources', resourceErrorHandler)`. The global
 * `express.json()` in index.ts rejects a malformed body before the router runs,
 * so the router's own handler never sees it and Express's default one would
 * print a stack trace. A non-local request still gets the router's plain 404.
 */
export function resourceErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (!isLocalResourceRequest(req)) return fail(res, 404, 'Not found');
  // Notes sync reads machine codes (`batch_too_large` halves the batch), not prose.
  if (String(req.path ?? '').startsWith('/cloud/skill-notes')) return notesErrorHandler(err, req, res, next);
  respondToError(res, err, homedir());
}

export function createResourceRouter(deps: ResourceRouterDeps): Router {
  const router = Router();
  const home = deps.home ?? homedir();
  const catalog = createResourceCatalog({
    sessionProjectPaths: deps.sessionProjectPaths,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.trashDir ? { trashDir: deps.trashDir } : {}),
  });
  deps.onCatalogReady?.(catalog);
  const isLocal = deps.isLocalRequest ?? isLocalResourceRequest;

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (isLocal(req)) {
      next();
      return;
    }
    fail(res, 404, 'Not found');
  });
  // Remote access needs no cloud connection, so it is mounted before the cloud block: when a connector is
  // mounted too, its generic /cloud router would otherwise answer these paths first.
  if (deps.remoteAccess) {
    router.use('/cloud/remote-access', createRemoteAccessRouter(deps.remoteAccess, isSameOriginWrite));
  }
  if (deps.cloud) {
    const cloud = deps.cloud;
    const directory = deps.cloudAliasDirectory;
    if (!directory) throw new Error('cloudAliasDirectory is required with a cloud connector');
    let cloudAliases: Promise<CloudAliasesService> | undefined;
    const getCloudAliases = () =>
      (cloudAliases ??= createCloudAliases({ cloud, home, directory, catalog: () => catalog.getOrStartCatalog() }));
    deps.onCloudAliasesReady?.(getCloudAliases);
    let jobs: Promise<ResourceJobs> | undefined;
    const getJobs = () =>
      (jobs ??= createResourceJobs({
        cloud,
        catalog,
        roots: globalRootPaths(deps.env ?? process.env, home),
        directory: deps.cloudJobDirectory ?? join(directory, 'resources'),
        getCloudAliases,
      }));
    let projects: Promise<ProjectJobs> | undefined;
    const getProjects = () =>
      (projects ??= getJobs().then((resources) =>
        createProjectJobs({
          cloud,
          resources,
          activeProjectPaths: deps.cloudActiveProjectPaths ?? deps.sessionProjectPaths,
          projectActivity: deps.projectActivity,
          home,
          // "Save a project" offers the catalog's project folders (display paths: `~/…`).
          candidatePaths: () =>
            catalog
              .getOrStartCatalog()
              .projects.filter((p) => p.exists && !p.isHome)
              .map((p) => (p.path.startsWith('~/') ? join(home, p.path.slice(2)) : p.path)),
          // The first scan after a start lists no projects until it ends: the tab would read
          // "No projects on this Mac yet" (code review, Oct 29 2026). Later scans keep the last list.
          candidatesReady: async () => {
            if (!catalog.getOrStartCatalog().projects.length) await catalog.whenIdle();
          },
        }),
      ));
    deps.onCloudProjectsReady?.(getProjects);
    // Attach the project owner before shared project job history/cancel/retry, including after a restart.
    const getOwnedJobs = async () => {
      await getProjects();
      return getJobs();
    };
    deps.onCloudJobsReady?.(getOwnedJobs);
    // Specific prefixes first: the generic connection router answers every other /cloud path.
    // The project and resource-job routers claim only their own prefixes and pass the rest on.
    router.use('/cloud/skill-notes', createNotesRouter(cloud));
    router.use('/cloud/aliases', createCloudAliasesRouter(getCloudAliases, isSameOriginWrite));
    router.use('/cloud', createProjectRouter(getProjects, isSameOriginWrite));
    router.use('/cloud', createResourceJobsRouter(getOwnedJobs, isSameOriginWrite));
    router.use('/cloud', createCloudRouter(cloud, isSameOriginWrite, deps.cloudGoogle));
  }
  router.use(json({ limit: '64kb' }));
  // SSH Resource Transfers and Project Sync were retired for the cloud (AASC-51):
  // their old prefixes answer like any unknown route, and no legacy service is built.
  router.use(['/transfers', '/sync'], (_req, res) => fail(res, 404, 'Not found'));

  const idOf = (req: Request): string | null => {
    const parsed = resourceIdSchema.safeParse(str(req.params.id));
    return parsed.success ? parsed.data : null;
  };

  router.get('/', (_req, res) => {
    res.json({ success: true, data: catalog.getOrStartCatalog() });
  });

  // Oct 23 2026: each skill's and command's uses in the last 90 days, by catalog id. Never
  // starts a scan (one started here would leave out the folders added in Sources), and never
  // answers an unknown count as zero: the client keeps what it shows on a 409 or 503.
  router.get('/usage', (_req, res) => {
    try {
      const current = catalog.getCatalog();
      if (!current.scannedAt) return fail(res, 409, 'The resources have not been scanned yet');
      const counts = deps.usageCounts ? deps.usageCounts() : new Map<string, TokenUse>();
      if (!counts) return fail(res, 503, 'Could not count resource uses');
      res.json({ success: true, data: { windowDays: USAGE_WINDOW_DAYS, byId: usageById(counts, current.resources) } });
    } catch (err) {
      log.error('resources', `usage failed: ${err instanceof Error ? err.message : String(err)}`);
      fail(res, 500, 'Could not count resource uses');
    }
  });

  router.post('/scan', (req, res) => {
    // A cross-site <form> can POST text/plain or urlencoded without a CORS
    // preflight; only a JSON body (which a form cannot send) may start a scan.
    if (!req.is('application/json')) return fail(res, 415, 'Content-Type must be application/json');
    const body = validate(scanBodySchema, req.body ?? {}, res);
    if (!body) return;
    res.json({ success: true, data: catalog.startScan(body.extraRoots ?? []) });
  });

  router.get('/item/:id', async (req, res) => {
    const id = idOf(req);
    try {
      const detail = id ? await catalog.getDetail(id) : null;
      if (!detail) return fail(res, 404, 'Resource not found');
      res.json({ success: true, data: detail });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  router.get('/item/:id/file', async (req, res) => {
    const id = idOf(req);
    if (!id) return fail(res, 404, 'Resource not found');
    const query = validate(fileQuerySchema, { path: str(req.query.path) }, res);
    if (!query) return;
    try {
      res.json({ success: true, data: await catalog.getFile(id, query.path) });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  router.get('/item/:id/compare', async (req, res) => {
    const id = idOf(req);
    if (!id) return fail(res, 404, 'Resource not found');
    const query = validate(compareQuerySchema, { against: str(req.query.against) }, res);
    if (!query) return;
    try {
      const compare = await catalog.getCompare(id, query.against);
      if (!compare) return fail(res, 404, 'Nothing to compare against');
      res.json({ success: true, data: compare });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  // ── The only writes: uninstall (a move into the trash) and restore ───────
  /** JSON only (a cross-site form cannot send it) and from the AASC page itself. */
  const writeAllowed = (req: Request, res: Response): boolean => {
    if (!req.is('application/json')) {
      fail(res, 415, 'Content-Type must be application/json');
      return false;
    }
    if (!isSameOriginWrite(req)) {
      fail(res, 403, 'Changes are accepted only from the AASC page itself');
      return false;
    }
    return true;
  };

  router.post('/item/:id/uninstall', async (req, res) => {
    if (!writeAllowed(req, res)) return;
    const id = idOf(req);
    if (!id) return fail(res, 404, 'Resource not found');
    const body = validate(uninstallBodySchema, req.body ?? {}, res);
    if (!body) return;
    try {
      res.json({ success: true, data: await catalog.uninstall(id, body.confirmName) });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  router.post('/trash/:trashId/restore', async (req, res) => {
    if (!writeAllowed(req, res)) return;
    const trashId = trashIdSchema.safeParse(str(req.params.trashId));
    if (!trashId.success) return fail(res, 400, 'Invalid trash id');
    try {
      res.json({ success: true, data: await catalog.restore(trashId.data) });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  // ── Abbreviation commands: a small file in ~/.claude or ~/.codex ─────────
  // The writes and every refusal live in resourceAliases.ts. This adds what
  // only the catalog knows: the target must exist, and the abbreviation must
  // not be the name of a real skill or command (the alias's own files, listed
  // by an earlier scan, don't count).
  router.post('/aliases', async (req, res) => {
    if (!writeAllowed(req, res)) return;
    const body = validate(aliasBodySchema, req.body ?? {}, res);
    if (!body) return;
    try {
      const current = catalog.getOrStartCatalog();
      if (current.resources.length === 0) {
        return fail(res, 409, current.state === 'ready' ? 'The catalog is empty.' : 'The first scan is still running; try again in a moment.');
      }
      // One collision rule for this route and cloud alias reconciliation.
      const realNames = aliasCatalogRealNames(current.resources, [body], home);
      const targetFound = current.resources.some((r) =>
        r.agent === body.agent && r.type === body.kind &&
        (r.origin === 'plugin' && r.pluginName ? `${r.pluginName}:${r.name}` : r.name) === body.target,
      );
      // 409, not 404: the client reads a 404 on /api/resources as "not available on this machine".
      if (!targetFound) return fail(res, 409, 'That skill or command is not in the catalog. Rescan and try again.');
      res.json({ success: true, data: await createAlias(body, { home, realNames }) });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  router.delete('/aliases', async (req, res) => {
    if (!writeAllowed(req, res)) return;
    const body = validate(aliasRemoveSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      res.json({ success: true, data: await removeAlias(body, { home }) });
    } catch (err) {
      sendError(res, err, home);
    }
  });

  // Last: errors raised inside the router (its own body parser when no global
  // one ran first, a handler that let something escape).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    respondToError(res, err, home);
  });

  return router;
}
