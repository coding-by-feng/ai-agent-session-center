import { z } from 'zod';
export const CloudIdSchema = z.uuid();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const CanonicalCloudIdSchema = CloudIdSchema.refine(
  (id) => id === id.toLowerCase(),
  'Canonical UUID required',
);
export const PackageFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    sha256: Sha256Schema,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  })
  .strict();
export const ResourceDependencySchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const PackageManifestSchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    agent: z.enum(['claude', 'codex', 'shared']),
    kind: z.enum(['skill', 'command', 'rule', 'agent', 'instruction', 'memory']),
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      // A resource name is display text: control characters are refused on purpose.
      // eslint-disable-next-line no-control-regex
      .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s)),
    scope: z.enum(['global', 'project']),
    projectId: CanonicalCloudIdSchema.nullable(),
    files: z.array(PackageFileSchema).min(1).max(2000),
    dependencies: z.array(ResourceDependencySchema).max(2000),
  })
  .strict()
  .superRefine((m, ctx) => {
    if ((m.scope === 'project') !== (m.projectId !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Project scope requires project ID',
      });
    if (m.files.reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Package too large' });
    const dependencies = new Set<string>();
    for (const d of m.dependencies) {
      const key = d.resourceId + ':' + d.version;
      if (dependencies.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate dependency' });
      dependencies.add(key);
    }
    const paths = new Set<string>(),
      hashes = new Map<string, number>();
    for (const f of m.files) {
      const parts = f.path.split('/');
      if (
        parts.length > 12 ||
        parts.some((p) => !p || p === '.' || p === '..') ||
        // Package paths are portable names: backslashes, colons and control characters are refused.
        // eslint-disable-next-line no-control-regex
        /[\\:\u0000-\u001f\u007f]/u.test(f.path) ||
        f.path !== f.path.normalize('NFC')
      )
        ctx.addIssue({ code: 'custom', message: 'Noncanonical relative path' });
      const folded = f.path.toLowerCase();
      if (paths.has(folded)) ctx.addIssue({ code: 'custom', message: 'Path collision' });
      paths.add(folded);
      if (hashes.has(f.sha256) && hashes.get(f.sha256) !== f.bytes)
        ctx.addIssue({ code: 'custom', message: 'Conflicting hash sizes' });
      hashes.set(f.sha256, f.bytes);
    }
    for (const path of paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++)
        if (paths.has(parts.slice(0, i).join('/')))
          ctx.addIssue({ code: 'custom', message: 'File-directory collision' });
    }
  });
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
export const BeginUploadSchema = z
  .object({
    manifest: PackageManifestSchema,
    baseVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    mutationId: CanonicalCloudIdSchema,
  })
  .strict();
export const BeginUploadResultSchema = z
  .object({
    uploadId: CanonicalCloudIdSchema,
    missingHashes: z.array(Sha256Schema),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type BeginUploadResult = z.infer<typeof BeginUploadResultSchema>;

export const ResourceVersionSchema = z
  .object({
    manifest: PackageManifestSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    digest: Sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;
export const ResourceHeadSchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    headVersion: z.number().int().positive(),
    deleted: z.boolean(),
  })
  .strict();
export const ResourceErrorDetailsSchema = z.union([
  z.object({ headVersion: z.number().int().nonnegative().nullable() }).strict(),
  z
    .object({
      references: z.array(
        z
          .object({
            kind: z.enum(['resource', 'project']),
            id: CanonicalCloudIdSchema,
            version: z.number().int().positive(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export type ResourceErrorDetails = z.infer<typeof ResourceErrorDetailsSchema>;

export type ResourceRef = z.infer<typeof ResourceDependencySchema>;
export interface PublicationPlan {
  id: string;
  items: {
    catalogId: string;
    manifest: PackageManifest;
    sourceDigest: string;
    baseVersion: number | null;
  }[];
  blocked: { catalogId: string; reason: string }[];
}
export interface InstallPlan {
  id: string;
  items: {
    id: string;
    resourceId: string;
    version: number;
    destinationLabel: string;
    action: 'add' | 'replace' | 'same' | 'blocked';
    reason?: string;
    files: { path: string; change: 'add' | 'change' | 'remove' | 'same' }[];
  }[];
}
export type InstallDecisions = Record<string, 'keep-local' | 'replace-with-backup' | 'skip'>;
export interface CloudJob {
  id: string;
  kind: 'publish' | 'download' | 'install' | 'get-project' | 'pull-project' | 'push-project';
  state: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  steps: {
    id: string;
    label: string;
    state: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
    error?: string;
    receiptId?: string;
    attention?: string;
  }[];
}

export const CloudJobSchema: z.ZodType<CloudJob> = z
  .object({
    id: z.uuid(),
    kind: z.enum(['publish', 'download', 'install', 'get-project', 'pull-project', 'push-project']),
    state: z.enum([
      'queued',
      'running',
      'complete',
      'partial',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1024),
            label: z.string().max(1024),
            state: z.enum(['pending', 'running', 'complete', 'failed', 'skipped']),
            error: z.string().max(4096).optional(),
            receiptId: z.uuid().optional(),
            attention: z.string().max(4096).optional(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export const PublicationPlanSchema: z.ZodType<PublicationPlan> = z
  .object({
    id: z.uuid(),
    items: z
      .array(
        z
          .object({
            catalogId: z.string().min(1).max(1024),
            manifest: PackageManifestSchema,
            sourceDigest: Sha256Schema,
            baseVersion: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(2000),
    blocked: z
      .array(z.object({ catalogId: z.string().max(1024), reason: z.string().max(4096) }).strict())
      .max(2000),
  })
  .strict();
export const InstallPlanSchema: z.ZodType<InstallPlan> = z
  .object({
    id: z.uuid(),
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            resourceId: z.uuid(),
            version: z.number().int().positive(),
            destinationLabel: z.string().max(2048),
            action: z.enum(['add', 'replace', 'same', 'blocked']),
            reason: z.string().max(4096).optional(),
            files: z
              .array(
                z
                  .object({
                    path: z.string().max(1024),
                    change: z.enum(['add', 'change', 'remove', 'same']),
                  })
                  .strict(),
              )
              .max(2000),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();

// AASC-62: Cloud → Resources as one sync list. A resource syncs once it was saved to cloud from
// this device or installed here; everything else in the account reads "Only in cloud".
export const SYNC_STATES = [
  'synced',
  'local-changed',
  'cloud-newer',
  'cloud-only',
  'conflict',
  'blocked',
  // Oct 23 2026: "Stop syncing on this Mac" (nothing moves here until Sync again), and a resource
  // this device synced that the cloud no longer has (removed on some device: never re-uploaded).
  'stopped',
  'removed',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const SyncItemSchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    /** The Library resource on this device it syncs with (Oct 23 2026); null when there is none here. */
    catalogId: z.string().min(1).max(1024).nullable(),
    name: z.string().min(1).max(256),
    agent: z.enum(['claude', 'codex', 'shared']),
    kind: z.enum(['skill', 'command', 'rule', 'agent', 'instruction', 'memory']),
    scope: z.enum(['global', 'project']),
    state: z.enum(SYNC_STATES),
    /** The cloud's latest version; null when the cloud has none left. */
    cloudVersion: z.number().int().positive().nullable(),
    /** The version this device last saved or installed; null when it never synced here. */
    syncedVersion: z.number().int().positive().nullable(),
    memory: z.boolean(),
    /** Why a `blocked` item can't sync. */
    reason: z.string().max(4096).optional(),
  })
  .strict();
export type SyncItem = z.infer<typeof SyncItemSchema>;
export const SyncStatusSchema = z
  .object({
    items: z.array(SyncItemSchema).max(10000),
    /** Items Sync now would move without a choice (memory counts, it still asks for its OK). */
    waiting: z.number().int().nonnegative(),
  })
  .strict();
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export const SyncChoiceSchema = z.enum(['mine', 'cloud']);
export const SyncRequestSchema = z
  .object({
    /** Changed in both places: keep this device's copy (upload it) or use the cloud's. */
    choices: z.record(CanonicalCloudIdSchema, SyncChoiceSchema).optional(),
    /** Memory resources the user said OK to for this run. */
    memory: z.array(CanonicalCloudIdSchema).max(10000).optional(),
    /** Move only these (a Library row's or a selection's sync); everything else is left alone. */
    only: z.array(CanonicalCloudIdSchema).max(10000).optional(),
  })
  .strict();
export type SyncRequest = z.infer<typeof SyncRequestSchema>;
/**
 * Oct 23 2026: stop syncing a resource on this device, sync it again, or remove it from the cloud
 * (every version; other devices then read it as `removed`).
 */
export const SyncControlRequestSchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    action: z.enum(['stop', 'resume', 'remove']),
  })
  .strict();
export type SyncControlRequest = z.infer<typeof SyncControlRequestSchema>;
export const SyncControlResultSchema = z
  .object({
    resourceId: CanonicalCloudIdSchema,
    action: z.enum(['stop', 'resume', 'remove']),
    /** How many cloud versions a remove deleted. */
    removedVersions: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SyncControlResult = z.infer<typeof SyncControlResultSchema>;
export const SyncResultSchema = z
  .object({
    jobs: z.array(CloudJobSchema).max(2),
    skipped: z
      .array(
        z
          .object({
            resourceId: CanonicalCloudIdSchema,
            name: z.string().max(256),
            reason: z.string().max(4096),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type SyncResult = z.infer<typeof SyncResultSchema>;
