/**
 * cloudBrowseApi.ts — the phone's read-only view of AASC Cloud (AASC-51), read
 * through the Mac's own cloud connection (server/mobile/phoneCloud.ts):
 *
 *   GET /api/phone-cloud/status                   connected or not, last sync, problem
 *   GET /api/phone-cloud/browse[?refresh=1]       resources and project records
 *   GET /api/phone-cloud/resources/<id>/versions  one resource's latest versions
 *
 * Nothing here writes: uploads, installs, restores, publishing, clones and
 * account changes stay on the Mac. Every answer is checked before it is drawn;
 * a failure comes back as a `CloudFetchError` whose words the screen shows.
 */
import { z } from 'zod';

const StateSchema = z.enum(['not-connected', 'unchecked', 'connected', 'offline', 'revoked']);
export type CloudState = z.infer<typeof StateSchema>;

const StatusShape = {
  connected: z.boolean(),
  state: StateSchema,
  lastSyncAt: z.string().max(64).nullable(),
  problem: z.string().max(400).nullable(),
};
const StatusSchema = z.object(StatusShape);
export type CloudStatus = z.infer<typeof StatusSchema>;

const ResourceSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(256),
  kind: z.enum(['skill', 'command', 'rule', 'agent', 'instruction', 'memory']),
  agent: z.enum(['claude', 'codex', 'shared']),
  scope: z.enum(['global', 'project']),
  version: z.number().int().positive(),
  updatedAt: z.string().max(64),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export type CloudResource = z.infer<typeof ResourceSchema>;

const ProjectSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(256),
  host: z.literal('github.com'),
  owner: z.string().max(64),
  repo: z.string().max(128),
  branch: z.string().max(256),
  resources: z.number().int().nonnegative(),
});
export type CloudProject = z.infer<typeof ProjectSchema>;

const VersionSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.string().max(64),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export type CloudVersion = z.infer<typeof VersionSchema>;

const BrowseSchema = z.object({
  ...StatusShape,
  resources: z.array(ResourceSchema).max(2000),
  projects: z.array(ProjectSchema).max(2000),
  truncated: z.boolean(),
});
export type CloudBrowse = z.infer<typeof BrowseSchema>;

const VersionsSchema = z.object({
  ...StatusShape,
  resource: ResourceSchema.nullable(),
  versions: z.array(VersionSchema).max(100),
  truncated: z.boolean(),
});
export type CloudVersions = z.infer<typeof VersionsSchema>;

/** `missing`: the Mac has no such item for this phone (More → Resources, plan 16). */
export type CloudFetchProblem = 'unreachable' | 'unsupported' | 'busy' | 'invalid' | 'missing';

/** What the phone says when it can't get an answer from the Mac. */
export const CLOUD_FETCH_WORDS: Record<CloudFetchProblem, string> = {
  unreachable: 'Couldn’t reach your Mac. Check that AASC is open there, then try again.',
  unsupported: 'Your Mac’s AASC can’t show AASC Cloud on a phone yet. Update AASC on your Mac.',
  busy: 'Your Mac read AASC Cloud a lot just now. Try again in a moment.',
  invalid: 'Your Mac sent an answer this phone can’t read. Update AASC on your Mac.',
  missing: 'Your Mac doesn’t have this any more, or doesn’t share it with this phone.',
};

/** The same, short enough for a list row's second line. */
export const CLOUD_FETCH_SHORT: Record<CloudFetchProblem, string> = {
  unreachable: 'Couldn’t reach your Mac',
  unsupported: 'Update AASC on your Mac to see it',
  busy: 'Try again in a moment',
  invalid: 'Update AASC on your Mac to see it',
  missing: 'Not on your Mac any more',
};

export class CloudFetchError extends Error {
  /** `words` replaces the problem's own words where a screen needs its own (More → Resources). */
  constructor(readonly problem: CloudFetchProblem, readonly retryAfter: number | null = null, words?: string) {
    super(words ?? CLOUD_FETCH_WORDS[problem]);
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new CloudFetchError('unreachable');
  }
  if (res.status === 404) throw new CloudFetchError('unsupported');
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retryAfter?: unknown } | null;
    const wait = typeof body?.retryAfter === 'number' && body.retryAfter > 0 ? Math.ceil(body.retryAfter) : null;
    throw new CloudFetchError('busy', wait);
  }
  if (!res.ok) throw new CloudFetchError('unreachable');
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new CloudFetchError('invalid');
  return parsed.data;
}

export function fetchCloudStatus(signal?: AbortSignal): Promise<CloudStatus> {
  return getJson('/api/phone-cloud/status', StatusSchema, signal);
}

export function fetchCloudBrowse(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<CloudBrowse> {
  return getJson(`/api/phone-cloud/browse${options.refresh ? '?refresh=1' : ''}`, BrowseSchema, options.signal);
}

export function fetchCloudVersions(resourceId: string, signal?: AbortSignal): Promise<CloudVersions> {
  return getJson(`/api/phone-cloud/resources/${encodeURIComponent(resourceId)}/versions`, VersionsSchema, signal);
}
