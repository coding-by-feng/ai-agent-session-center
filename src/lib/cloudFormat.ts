import type { CloudJob } from '@/types/cloudResources';
export function cloudJobProgress(job: CloudJob): string {
  return `${job.steps.filter((s) => s.state === 'complete').length} of ${job.steps.length} complete`;
}
export function cloudPackageSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}
