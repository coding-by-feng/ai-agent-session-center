/**
 * phoneResourcesApi.ts — what More → Resources reads (plan 16, P1), through the Mac
 * (server/mobile/phoneResourcesRouter.ts):
 *
 *   GET /api/phone-resources/library                the Library: resources this phone may see, their uses
 *   GET /api/phone-resources/item/<id>              one resource: its preview, fields and files
 *   GET /api/phone-resources/item/<id>/file?path=   one file of it
 *   GET /api/phone-resources/sync[?refresh=1]       Cloud sync: each saved resource's state
 *   GET /api/phone-resources/projects[?refresh=1]   Projects: GitHub accounts, each checkout
 *
 * Every answer is checked before it is drawn; a failure is a `CloudFetchError` whose words the
 * screen shows (`useCloudRead` keeps the last answer on screen). Nothing here writes yet.
 */
import { z } from 'zod';
import { RESOURCE_TYPES } from '@/types/resources';
import { SyncItemSchema } from '@/types/cloudResources';
import { CheckoutStateSchema, GithubAccountsSchema } from '@/types/cloudProjects';
import type { PhoneLibrary, PhoneProjects, PhoneResourceDetail, PhoneResourceFile, PhoneSync } from '@/types/phoneResources';
import { CloudFetchError } from './cloudBrowseApi';

const UNSUPPORTED = 'Your Mac’s AASC can’t show Resources on a phone yet. Update AASC on your Mac.';
const CHANGED = 'This changed on your Mac since the list was read. Pull to refresh, then open it again.';
const REFUSED = 'Your Mac won’t show this file.';

const SummarySchema = z.looseObject({
  id: z.string().max(64),
  type: z.enum(RESOURCE_TYPES),
  agent: z.enum(['claude', 'codex', 'shared']),
  scope: z.enum(['global', 'project']),
  origin: z.enum(['user', 'plugin', 'system', 'synced', 'linked']),
  format: z.enum(['markdown', 'config', 'script', 'text', 'policy']),
  name: z.string().max(4096),
  description: z.string().max(20_000).optional(),
  projectId: z.string().max(256).optional(),
  path: z.string().max(4096),
  linkTarget: z.string().max(4096).optional(),
  pluginName: z.string().max(256).optional(),
  // Not shown on the phone yet; checked so a bad value is dropped alone, not the whole list.
  publisher: z.object({
    kind: z.enum(['anthropic', 'openai', 'third-party']),
    name: z.string().max(256),
  }).optional().catch(undefined),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  mtimeMs: z.number(),
  variantIds: z.array(z.string().max(64)).max(50),
  findingCodes: z.array(z.string().max(64)).max(100),
});

const UsageSchema = z.object({
  typed: z.number().int().nonnegative(),
  agent: z.number().int().nonnegative(),
  lastAt: z.number(),
  tokens: z.array(z.string().max(512)).max(20),
  sharedWith: z.number().int().nonnegative().optional(),
});

const LibrarySchema = z.object({
  state: z.enum(['idle', 'scanning', 'ready', 'error']),
  scannedAt: z.number().nullable(),
  resources: z.array(SummarySchema).max(20_000),
  projects: z.array(z.object({ id: z.string().max(256), name: z.string().max(1024), path: z.string().max(4096) })).max(2000),
  usage: z.object({
    windowDays: z.number().int().positive(),
    scope: z.enum(['all', 'shared']),
    byId: z.record(z.string(), UsageSchema),
  }).nullable(),
});

const DetailSchema = z.looseObject({
  summary: SummarySchema,
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  frontmatterError: z.string().max(4096).optional(),
  body: z.string().optional(),
  bodyTruncated: z.boolean().optional(),
  fields: z.array(z.object({
    key: z.string().max(4096),
    value: z.string(),
    masked: z.boolean(),
    kind: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']),
  })).max(5000).optional(),
  files: z.array(z.object({
    path: z.string().max(4096),
    bytes: z.number().nonnegative(),
    isText: z.boolean(),
    isSymlink: z.boolean().optional(),
  })).max(5000).optional(),
  findings: z.array(z.unknown()).max(1000),
});

const FileSchema = z.object({
  path: z.string().max(4096),
  bytes: z.number().nonnegative(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  binary: z.boolean().optional(),
});

const LinkShape = {
  connected: z.boolean(),
  state: z.enum(['not-connected', 'unchecked', 'connected', 'offline', 'revoked']),
  problem: z.string().max(400).nullable(),
  readAt: z.string().max(64).nullable(),
};

const SyncSchema = z.object({ ...LinkShape, items: z.array(SyncItemSchema).max(10_000) });

const ProjectsSchema = z.object({
  ...LinkShape,
  accounts: GithubAccountsSchema,
  projects: z.array(z.object({
    id: z.string().max(64),
    name: z.string().max(256),
    owner: z.string().max(64),
    repo: z.string().max(128),
    branch: z.string().max(256),
    local: z.object({
      state: CheckoutStateSchema,
      branch: z.string().max(256).nullable(),
      path: z.string().max(4096).nullable(),
      ahead: z.number().int().nonnegative().nullable(),
      behind: z.number().int().nonnegative().nullable(),
      account: z.string().max(64).nullable(),
    }).nullable(),
  })).max(1000),
  truncated: z.boolean(),
});

/**
 * One GET, checked. `item`: a resource or one of its files, where a 404 means "no such item here"
 * (not an older Mac), a 409 that it changed since the scan, and a 400 a file the Mac won't show.
 */
async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, item = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new CloudFetchError('unreachable');
  }
  if (res.status === 404) throw item ? new CloudFetchError('missing') : new CloudFetchError('unsupported', null, UNSUPPORTED);
  if (item && res.status === 409) throw new CloudFetchError('missing', null, CHANGED);
  if (item && res.status === 400) throw new CloudFetchError('invalid', null, REFUSED);
  if (res.status === 429) throw new CloudFetchError('busy');
  if (!res.ok) throw new CloudFetchError('unreachable');
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new CloudFetchError('invalid');
  return parsed.data;
}

const refreshQuery = (refresh?: boolean) => (refresh ? '?refresh=1' : '');

export function fetchPhoneLibrary(signal?: AbortSignal): Promise<PhoneLibrary> {
  // Checked for what the phone draws; the rest of each summary passes through as the Mac sent it.
  return getJson('/api/phone-resources/library', LibrarySchema, signal) as unknown as Promise<PhoneLibrary>;
}

export function fetchPhoneResource(id: string, signal?: AbortSignal): Promise<PhoneResourceDetail> {
  return getJson(`/api/phone-resources/item/${encodeURIComponent(id)}`, DetailSchema, signal, true) as unknown as Promise<PhoneResourceDetail>;
}

export function fetchPhoneResourceFile(id: string, path: string, signal?: AbortSignal): Promise<PhoneResourceFile> {
  const query = new URLSearchParams({ path });
  return getJson(`/api/phone-resources/item/${encodeURIComponent(id)}/file?${query}`, FileSchema, signal, true);
}

export function fetchPhoneSync(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PhoneSync> {
  return getJson(`/api/phone-resources/sync${refreshQuery(options.refresh)}`, SyncSchema, options.signal);
}

export function fetchPhoneProjects(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PhoneProjects> {
  return getJson(`/api/phone-resources/projects${refreshQuery(options.refresh)}`, ProjectsSchema, options.signal);
}
