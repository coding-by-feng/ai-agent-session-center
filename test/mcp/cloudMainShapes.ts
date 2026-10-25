// test/mcp/cloudMainShapes.ts — what the routes that exist only in the main checkout's uncommitted work answer
// (plan 2026-10-25 P6, "Routes: where each one exists"), for the P6 tool tests to fake with. Each shape names the main
// file:line it was read from (the main checkout, /Users/kasonzhan/Documents/claude/agent-manager, read-only); nothing
// here is imported from it. Each one is the `data` of `{ success: true, data }`: wrap it in `envelope()`.
//
// MISSING is how a build without one of those routes answers, as the loopback client reports it. The branch probe
// (cloudRoutesOnBranch.test.ts) holds three of them to what the branch's real routers answer.
import type { InternalResponse } from '../../server/mcp/client.js';
import { PROJECT_ID, RESOURCE_ID } from './cloudFixtures.js';

export const MEMORY_ID = 'd1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
export const NEWER_ID = 'e2f3a4b5-6c7d-4e8f-9a0b-1c2d3e4f5a6b';
export const CLOUD_ONLY_ID = 'f3a4b5c6-7d8e-4f9a-8b1c-2d3e4f5a6b7c';
export const CONFLICT_ID = 'a4b5c6d7-8e9f-4a0b-9c2d-3e4f5a6b7c8d';
export const BLOCKED_ID = 'b5c6d7e8-9f0a-4b1c-8d3e-4f5a6b7c8d9e';
export const STOPPED_ID = 'c6d7e8f9-0a1b-4c2d-9e4f-5a6b7c8d9e0f';
export const REMOVED_ID = 'd7e8f9a0-1b2c-4d3e-8f5a-6b7c8d9e0f1a';
export const SYNCED_ID = 'e8f9a0b1-2c3d-4e4f-9a6b-7c8d9e0f1a2b';
export const PUBLISH_JOB_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const INSTALL_JOB_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
export const PUSH_JOB_ID = '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f';
export const SAVED_PROJECT_ID = '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a';

/** A checkout folder the shapes name. Under no real home: a tool test that needs one under home builds its own. */
export const CHECKOUT = '/Users/me/code/demo';

const item = (resourceId: string, name: string, state: string, over: Record<string, unknown> = {}) => ({
  resourceId,
  catalogId: `claude:skill:global:${name}`,
  name,
  agent: 'claude',
  kind: 'skill',
  scope: 'global',
  state,
  cloudVersion: 3,
  syncedVersion: 2,
  memory: false,
  ...over,
});

/**
 * GET /sync-status (main server/cloud/resourceRouter.ts:97) → `SyncStatus` (main src/types/cloudResources.ts:289, items
 * as SyncItemSchema :269, states SYNC_STATES :256): one item in every state, one memory item that changed here.
 */
export const SYNC_STATUS: unknown = {
  items: [
    item(SYNCED_ID, 'synced-skill', 'synced', { syncedVersion: 3 }),
    item(RESOURCE_ID, 'alpha-skill', 'local-changed'),
    item(MEMORY_ID, 'project-memory', 'local-changed', { kind: 'memory', agent: 'shared', catalogId: 'shared:memory:global:project-memory', memory: true }),
    item(NEWER_ID, 'newer-skill', 'cloud-newer'),
    item(CLOUD_ONLY_ID, 'cloud-only-skill', 'cloud-only', { catalogId: null, syncedVersion: null }),
    item(CONFLICT_ID, 'both-changed', 'conflict'),
    item(BLOCKED_ID, 'blocked-skill', 'blocked', { reason: 'It names a file outside the skill folder.' }),
    item(STOPPED_ID, 'stopped-skill', 'stopped'),
    item(REMOVED_ID, 'removed-skill', 'removed', { cloudVersion: null }),
  ],
  waiting: 4,
};

const job = (id: string, kind: string, state: string, steps: unknown[]) => ({ id, kind, state, steps });

/**
 * POST /sync-now (main server/cloud/resourceRouter.ts:104; service resourceJobs.ts:449) → `SyncResult` (main
 * src/types/cloudResources.ts:329): at most two jobs (an upload, then a download) and what it left out, with why.
 */
export const SYNC_NOW_RESULT: unknown = {
  jobs: [
    job(PUBLISH_JOB_ID, 'publish', 'queued', [{ id: 'claude:skill:global:alpha-skill', label: 'alpha-skill', state: 'pending' }]),
    job(INSTALL_JOB_ID, 'install', 'queued', [{ id: NEWER_ID, label: 'newer-skill', state: 'pending' }]),
  ],
  skipped: [{ resourceId: CONFLICT_ID, name: 'both-changed', reason: 'Changed here and in the cloud: choose which to keep.' }],
};

/** POST /sync-control (main server/cloud/resourceRouter.ts:113; resourceJobs.ts:594) → main src/types/cloudResources.ts:320. */
export const SYNC_CONTROL_RESULT: unknown = { resourceId: RESOURCE_ID, action: 'stop' };

const repository = (name: string) => ({ provider: 'github', owner: 'octo', name, url: `https://github.com/octo/${name}`, branch: 'main' });

/**
 * GET /projects/candidates (main server/cloud/projectRouter.ts:64; projectJobs.ts:546) → `{ items: ProjectCandidate[] }`
 * (main src/types/cloudProjects.ts:148, :157): two folders, the second already saved as SAVED_PROJECT_ID.
 */
export const CANDIDATES: unknown = {
  items: [
    { path: CHECKOUT, repository: repository('demo'), projectId: null },
    { path: '/Users/me/code/saved', repository: repository('saved'), projectId: SAVED_PROJECT_ID },
  ],
};

/**
 * GET /projects/:id/local as main answers it (main server/cloud/projectRouter.ts:166; projectJobs.ts:514) → `LocalProject`
 * (main src/types/cloudProjects.ts:117), with `path`, `ahead`, `behind` and `account`. `missing` has no checkout, so
 * every field but `account` is null (projectJobs.ts:518-528).
 */
export const LOCAL_MAIN = (state: string, over: object = {}): unknown =>
  state === 'missing'
    ? { state, branch: null, openUrl: null, localProjectId: null, path: null, ahead: null, behind: null, account: null, ...over }
    : {
        state,
        branch: 'main',
        openUrl: state === 'wrong-remote' ? null : `/project-browser?path=${encodeURIComponent(CHECKOUT)}`,
        localProjectId: 'local-demo',
        path: CHECKOUT,
        ahead: state === 'ahead' || state === 'diverged' ? 2 : 0,
        behind: state === 'diverged' ? 1 : 0,
        account: 'octo-cat',
        ...over,
      };

/** GET /projects/:id/local as the branch answers it (src/types/cloudProjects.ts:108 here): no path, ahead, behind or account. */
export const LOCAL_BRANCH = (state: string): unknown =>
  state === 'missing'
    ? { state, branch: null, openUrl: null, localProjectId: null }
    : { state, branch: 'main', openUrl: `/project-browser?path=${encodeURIComponent(CHECKOUT)}`, localProjectId: 'local-demo' };

/**
 * POST /projects/:id/remove (main server/cloud/projectRouter.ts:121; projectJobs.ts:553) → the record, `deleted: true`,
 * its version one past the one removed (main src/types/cloudProjects.ts:47). No folder, mapping or git is touched.
 */
export const REMOVED_RECORD: unknown = {
  id: PROJECT_ID,
  version: 4,
  name: 'demo',
  repository: repository('demo'),
  description: '',
  resources: [],
  deleted: true,
};

/** POST /projects/:id/push (main server/cloud/projectRouter.ts:139; projectJobs.ts:603-626) → a `push-project` job (main src/types/cloudResources.ts:163). */
export const PUSH_JOB: unknown = job(PUSH_JOB_ID, 'push-project', 'queued', [{ id: 'push', label: 'Push commits', state: 'pending' }]);

/**
 * POST /remote-access/refresh (main server/cloud/remoteAccessRouter.ts:62, mounted server/resourceRouter.ts:236) → the
 * view (main src/types/remoteAccess.ts:66), the shape P1's GET /remote-access reads.
 */
export const REMOTE_VIEW: unknown = {
  tailscale: { state: 'connected', address: '100.101.102.103', account: 'me@example.test', tailnet: 'example.ts.net', dnsName: 'studio.example.ts.net', canOpenApp: true },
  publish: { state: 'published', tailnet: '100.101.102.103', port: 3333, at: 1_700_000_000_000 },
  phones: [
    { id: 'phone-device-1', label: 'Kason’s iPhone', platform: 'ios', status: 'active', hasTailnet: true, tailnetSentAt: 1_700_000_000_000, lastPath: 'tailnet', lastPathAt: 1_700_000_000_500 },
  ],
  port: 3333,
};

/**
 * How a build without the route answers, as the loopback client reports it (server/mcp/client.ts `readResponse`):
 * - notFound: a POST no router has, which Express's own last handler answers 404 with an HTML page (no JSON);
 * - page: an unknown GET outside the cloud routers, which the app's page answers 200 (no JSON);
 * - media: a GET under /resources/cloud with no route, which the connection router's JSON check answers 415
 *   (server/cloud/router.ts:32-35);
 * - idClash: GET /projects/candidates, which the branch's `/projects/:id` takes, whose id check fails: 400
 *   `invalid_request` (server/cloud/projectRouter.ts:71-75 and its error handler).
 */
export const MISSING: {
  notFound: InternalResponse<unknown>;
  page: InternalResponse<unknown>;
  media: InternalResponse<unknown>;
  idClash: InternalResponse<unknown>;
} = {
  notFound: { ok: false, status: 404, data: null, error: 'HTTP 404' },
  page: { ok: true, status: 200, data: null, error: null },
  media: {
    ok: false,
    status: 415,
    data: { success: false, error: 'Content-Type must be application/json' },
    error: 'Content-Type must be application/json',
  },
  idClash: {
    ok: false,
    status: 400,
    data: { success: false, error: { code: 'invalid_request', message: 'Invalid cloud project request.' } },
    error: 'HTTP 400',
  },
};
