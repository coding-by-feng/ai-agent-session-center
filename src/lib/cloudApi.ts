/** A reviewed identity is always supplied by the caller; never silently refresh/retry under another account. */
import { z } from 'zod';
import {
  ProjectRecordSchema,
  ProjectMutationSchema,
  ProjectListSchema,
  LocalProjectSchema,
  type GetProjectInput,
} from '@/types/cloudProjects';
import type { CloudConnection, CloudStatus } from '@/types/cloud';
import {
  CloudJobSchema,
  PublicationPlanSchema,
  InstallPlanSchema,
  ResourceVersionSchema,
  type ResourceRef,
  type InstallDecisions,
} from '@/types/cloudResources';
import type { ResourceSelection } from '@/types/resourceSelection';
export type CloudReviewBinding = Pick<
  CloudConnection,
  'backendOrigin' | 'accountId' | 'generation'
>;
export class CloudApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export const cloudBindingHeaders = (binding: CloudReviewBinding) => ({
  'x-aasc-cloud-backend': binding.backendOrigin,
  'x-aasc-cloud-account': binding.accountId,
  'x-aasc-cloud-generation': String(binding.generation),
});
async function request<T>(
  path: string,
  method: string,
  binding: CloudReviewBinding | undefined,
  body: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/resources/cloud' + path, {
    method,
    signal,
    headers: {
      ...(binding ? cloudBindingHeaders(binding) : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.success !== true) {
    const error = envelope.error;
    throw new CloudApiError(
      typeof error?.code === 'string' ? error.code : 'cloud_error',
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : 'Cloud action failed.',
      error?.details,
    );
  }
  return schema.parse(envelope.data);
}
const uuid = (id: string) => z.uuid().parse(id);
const connection = z
  .object({
    backendOrigin: z.string().url(),
    accountId: z.uuid(),
    deviceId: z.uuid(),
    deviceName: z.string(),
    generation: z.number().int().nonnegative().safe(),
  })
  .strict();
const status: z.ZodType<CloudStatus> = z
  .object({
    connection: connection.nullable(),
    state: z.enum(['disconnected', 'connected', 'offline', 'revoked']),
    lastError: z.string().nullable(),
  })
  .strict();
export const cloudApi = {
  listProjects: (
    binding: CloudReviewBinding,
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    return request(
      '/projects' + (params.size ? '?' + params : ''),
      'GET',
      binding,
      undefined,
      ProjectListSchema,
      signal,
    );
  },
  project: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}`, 'GET', binding, undefined, ProjectRecordSchema, signal),
  saveProject: (
    mutation: z.infer<typeof ProjectMutationSchema>,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) =>
    request(
      mutation.baseVersion === null ? '/projects' : `/projects/${uuid(mutation.value.id)}`,
      mutation.baseVersion === null ? 'POST' : 'PUT',
      binding,
      ProjectMutationSchema.parse(mutation),
      ProjectRecordSchema,
      signal,
    ),
  associateProject: (id: string, path: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(
      `/projects/${uuid(id)}/associate`,
      'POST',
      binding,
      { path },
      LocalProjectSchema,
      signal,
    ),
  getProject: (
    id: string,
    input: GetProjectInput,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request(`/projects/${uuid(id)}/get`, 'POST', binding, input, CloudJobSchema, signal),
  pullProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/pull`, 'POST', binding, {}, CloudJobSchema, signal),
  localProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/local`, 'GET', binding, undefined, LocalProjectSchema, signal),
  projectResourcePlan: (
    jobId: string,
    binding: CloudReviewBinding,
    resourceVersions?: ResourceRef[],
    signal?: AbortSignal,
  ) =>
    request(
      `/projects/jobs/${uuid(jobId)}/resources-plan`,
      'POST',
      binding,
      { ...(resourceVersions ? { resourceVersions } : {}) },
      InstallPlanSchema,
      signal,
    ),
  retryProjectResources: (
    jobId: string,
    binding: CloudReviewBinding,
    review?: { planId: string; decisions: InstallDecisions },
    signal?: AbortSignal,
  ) =>
    request(
      `/projects/jobs/${uuid(jobId)}/retry-resources`,
      'POST',
      binding,
      { ...(review ? { review } : {}) },
      CloudJobSchema,
      signal,
    ),
  status: (signal?: AbortSignal) => request('/status', 'GET', undefined, undefined, status, signal),
  recheck: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/recheck', 'POST', binding, {}, status, signal),
  connect: (
    input: { backendUrl: string; pairingCode: string; deviceName: string },
    signal?: AbortSignal,
  ) => request('/connect', 'POST', undefined, input, connection, signal),
  disconnect: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/disconnect', 'POST', binding, {}, status, signal),
  revoke: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/revoke', 'POST', binding, {}, status, signal),
  listResources: (
    binding: CloudReviewBinding,
    query: { cursor?: string; limit?: number; projectId?: string } = {},
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    return request(
      '/resources' + (params.size ? '?' + params : ''),
      'GET',
      binding,
      undefined,
      z.object({ items: z.array(ResourceVersionSchema), nextCursor: z.uuid().nullable() }).strict(),
      signal,
    );
  },
  buildPublicationPlan: (
    selection: ResourceSelection,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request('/publish-plans', 'POST', binding, { selection }, PublicationPlanSchema, signal),
  publishPlan: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/publish-plans/${uuid(id)}/run`, 'POST', binding, {}, CloudJobSchema, signal),
  planInstall: (
    input: ResourceRef & { localProjectId?: string },
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request('/install-plans', 'POST', binding, input, InstallPlanSchema, signal),
  runInstall: (
    id: string,
    decisions: InstallDecisions,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) =>
    request(
      `/install-plans/${uuid(id)}/run`,
      'POST',
      binding,
      { decisions },
      CloudJobSchema,
      signal,
    ),
  download: (ref: ResourceRef, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/downloads', 'POST', binding, ref, CloudJobSchema, signal),
  async downloadFile(id: string, binding: CloudReviewBinding, signal?: AbortSignal) {
    const response = await fetch(`/api/resources/cloud/downloads/${uuid(id)}/file`, {
      headers: cloudBindingHeaders(binding),
      signal,
    });
    if (!response.ok) {
      const envelope = await response.json();
      throw new CloudApiError(
        envelope.error?.code ?? 'download_failed',
        envelope.error?.message ?? 'Prepared download unavailable.',
      );
    }
    return response.blob();
  },
  job: (id: string, signal?: AbortSignal) =>
    request(`/jobs/${uuid(id)}`, 'GET', undefined, undefined, CloudJobSchema, signal),
  cancel: (id: string, signal?: AbortSignal) =>
    request(`/jobs/${uuid(id)}/cancel`, 'POST', undefined, {}, CloudJobSchema, signal),
  retry: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/jobs/${uuid(id)}/retry`, 'POST', binding, {}, CloudJobSchema, signal),
  restore: (receiptId: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(
      `/installs/${uuid(receiptId)}/restore`,
      'POST',
      binding,
      {},
      z
        .object({
          id: z.uuid(),
          resourceId: z.uuid(),
          version: z.number().int().positive(),
          state: z.enum([
            'prepared',
            'backed-up',
            'installed',
            'restoring',
            'restored',
            'attention',
          ]),
          canRestore: z.boolean(),
        })
        .strict(),
      signal,
    ),
};
