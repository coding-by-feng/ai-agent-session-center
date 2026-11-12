import { z } from 'zod';
import {
  ResourceVersionSchema,
  CloudJobSchema,
  SyncStatusSchema,
  type CloudJob,
} from '@/types/cloudResources';
import {
  ProjectFoldersSchema,
  ProjectMetasSchema,
  ProjectRecordSchema,
} from '@/types/cloudProjects';
import type { CloudReviewBinding } from '@/lib/cloudApi';
export const cacheKey = (b: CloudReviewBinding | null) =>
  b ? JSON.stringify([b.backendOrigin, b.accountId]) : '';
const schema = z.object({
  resources: z.array(ResourceVersionSchema),
  /**
   * The last sync list this browser read (AASC-62), shown as stale until read again. A list saved
   * in an older shape (before `catalogId`, Oct 23 2026) is dropped on its own, never the whole
   * cache: the job history next to it must survive an upgrade.
   */
  sync: SyncStatusSchema.optional().catch(undefined),
  projects: z.array(ProjectRecordSchema),
  /**
   * The Projects tab's last folder list and ♥/tags (Oct 29 2026), shown until read again. Like
   * `sync`, a stored shape this build can't read is dropped on its own.
   */
  projectFolders: ProjectFoldersSchema.optional().catch(undefined),
  projectMeta: ProjectMetasSchema.optional().catch(undefined),
  jobs: z.array(
    z.object({ job: CloudJobSchema, generation: z.number(), projectId: z.string().optional() }),
  ),
  savedAt: z.number(),
});
export type CloudCache = z.infer<typeof schema>;
export type SavedJob = CloudCache['jobs'][number];
export function readCache(key: string): CloudCache {
  try {
    return schema.parse(JSON.parse(localStorage.getItem('aasc.cloud.browse.' + key) ?? ''));
  } catch {
    return { resources: [], projects: [], jobs: [], savedAt: 0 };
  }
}
export function writeCache(key: string, patch: Partial<CloudCache>) {
  const next = { ...readCache(key), ...patch };
  try {
    localStorage.setItem('aasc.cloud.browse.' + key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
export function rememberJob(key: string, job: CloudJob, generation: number, projectId?: string) {
  return writeCache(key, {
    jobs: [
      { job, generation, ...(projectId ? { projectId } : {}) },
      ...readCache(key).jobs.filter((j) => j.job.id !== job.id),
    ].slice(0, 30),
  });
}
