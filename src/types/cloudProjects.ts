import { z } from 'zod';
import { ResourceDependencySchema, CanonicalCloudIdSchema } from './cloudResources.js';
export function canonicalGithub(input: string): string | null {
  const m =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      input,
    );
  if (!m || m[0] !== input) return null;
  const owner = m[1].toLowerCase(),
    name = m[2].toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner) ||
    name.length > 100 ||
    ['.', '..'].includes(name) ||
    name.endsWith('.git')
  )
    return null;
  return `https://github.com/${owner}/${name}`;
}
const ProjectRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Control characters are refused on purpose: these fields are names and Git refs, never raw bytes.
// eslint-disable-next-line no-control-regex
const ProjectTextSchema = z.string().refine((s) => !/[\u0000-\u001f\u007f-\u009f]/u.test(s));
export const GithubRepositorySchema = z
  .object({
    provider: z.literal('github'),
    owner: ProjectTextSchema.min(1).max(39),
    name: ProjectTextSchema.min(1).max(100),
    url: ProjectTextSchema.min(1).max(512),
    branch: ProjectTextSchema.min(1)
      .max(256)
      .refine(
        (s) =>
          s === s.trim() &&
          !s.startsWith('-') &&
          !s.startsWith('/') &&
          !s.endsWith('/') &&
          !s.endsWith('.') &&
          !s.includes('..') &&
          !s.includes('@{') &&
          !/[ ~^:?*[\\]/u.test(s) &&
          s !== '@' &&
          !s.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock')),
      ),
  })
  .strict();
export const ProjectRecordSchema = z
  .object({
    id: CanonicalCloudIdSchema,
    version: ProjectRevisionSchema,
    name: ProjectTextSchema.min(1)
      .max(256)
      .refine((s) => s === s.trim()),
    repository: GithubRepositorySchema.refine(
      (r) =>
        canonicalGithub(r.url) === r.url && r.url === `https://github.com/${r.owner}/${r.name}`,
    ),
    description: z
      .string()
      .max(4096)
      // Newlines and tabs are allowed in a description; NUL and C1 controls are not.
      // eslint-disable-next-line no-control-regex
      .refine((s) => !/[\u0000\u007f-\u009f]/u.test(s)),
    resources: z
      .array(ResourceDependencySchema)
      .max(2000)
      .refine((items) => new Set(items.map((r) => r.resourceId)).size === items.length),
    deleted: z.boolean(),
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
export type Mutation<T> = {
  mutationId: string;
  baseVersion: number | null;
  value: T;
};
export const ProjectMutationSchema = z
  .object({
    mutationId: CanonicalCloudIdSchema,
    baseVersion: ProjectRevisionSchema.nullable(),
    value: ProjectRecordSchema,
  })
  .strict();
export const DeleteProjectSchema = z
  .object({
    id: CanonicalCloudIdSchema,
    baseVersion: ProjectRevisionSchema,
    mutationId: CanonicalCloudIdSchema,
  })
  .strict();
export const ProjectListSchema = z
  .object({
    items: z.array(ProjectRecordSchema),
    nextCursor: CanonicalCloudIdSchema.nullable(),
  })
  .strict();

/**
 * A checkout against its GitHub branch, as of the last fetch: `ready` has nothing of its own to
 * push (it may be behind), `ahead` only has commits to push, `diverged` has both.
 */
export const CheckoutStateSchema = z.enum([
  'missing',
  'ready',
  'ahead',
  'dirty',
  'diverged',
  'detached',
  'wrong-remote',
  'busy',
]);
export type CheckoutState = z.infer<typeof CheckoutStateSchema>;
/** A GitHub login, as GitHub allows it: letters, digits and single inner hyphens, 1–39. */
export const GithubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);
export const LocalProjectSchema = z
  .object({
    state: CheckoutStateSchema,
    branch: z.string().nullable(),
    // Rendered as a link: only ever the local project browser, never another origin or scheme.
    openUrl: z
      .string()
      .regex(/^\/project-browser\?path=[^\s]*$/)
      .nullable(),
    localProjectId: z.string().nullable(),
    /** The checkout's folder on this device (AASC-63); null when it isn't here. */
    path: z.string().max(4096).nullable(),
    /** Commits here and not on GitHub, and the other way round, as of the last fetch. */
    ahead: z.number().int().nonnegative().nullable(),
    behind: z.number().int().nonnegative().nullable(),
    /** The GitHub account this device uses for the project; null is this Mac's own Git sign-in. */
    account: GithubLoginSchema.nullable(),
  })
  .strict();
export type LocalProject = z.infer<typeof LocalProjectSchema>;
/** The GitHub CLI's accounts on this device (AASC-63). Tokens stay in its keychain, never here. */
export const GithubAccountsSchema = z
  .object({
    installed: z.boolean(),
    accounts: z
      .array(z.object({ login: GithubLoginSchema, active: z.boolean(), ok: z.boolean() }).strict())
      .max(50),
  })
  .strict();
export type GithubAccounts = z.infer<typeof GithubAccountsSchema>;
/** A git folder on this device whose origin is on GitHub: what "Save a project" offers. */
export const ProjectCandidateSchema = z
  .object({
    path: z.string().min(1).max(4096),
    repository: GithubRepositorySchema,
    /** The saved cloud project with this repository, when there is one. */
    projectId: CanonicalCloudIdSchema.nullable(),
  })
  .strict();
export type ProjectCandidate = z.infer<typeof ProjectCandidateSchema>;
export const ProjectCandidatesSchema = z
  .object({ items: z.array(ProjectCandidateSchema).max(500) })
  .strict();
export const GetProjectSchema = z
  .object({
    parentPath: z.string().min(1).max(4096),
    directoryName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
      .refine((s) => !s.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)),
    // AASC-63: Clone is HTTPS with the project's GitHub account; both stay optional for old callers.
    transport: z.enum(['https', 'ssh']).default('https'),
    resourceVersions: z.array(ResourceDependencySchema).max(2000).default([]),
  })
  .strict();
export type GetProjectInput = z.infer<typeof GetProjectSchema>;
