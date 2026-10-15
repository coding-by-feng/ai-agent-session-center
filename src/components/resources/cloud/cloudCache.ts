import { z } from 'zod';
import { ResourceVersionSchema, CloudJobSchema, type CloudJob } from '@/types/cloudResources';
import { ProjectRecordSchema } from '@/types/cloudProjects';
import type { CloudReviewBinding } from '@/lib/cloudApi';
export const cacheKey = (b: CloudReviewBinding | null) =>
  b ? JSON.stringify([b.backendOrigin, b.accountId]) : '';
const schema = z.object({
  resources: z.array(ResourceVersionSchema),
  projects: z.array(ProjectRecordSchema),
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
