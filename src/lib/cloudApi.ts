/** A reviewed identity is always supplied by the caller; never silently refresh/retry under another account. */
import { z } from 'zod';
import {
  ProjectRecordSchema,
  ProjectMutationSchema,
  ProjectListSchema,
  LocalProjectSchema,
  GetProjectSchema,
  GithubAccountsSchema,
  ProjectCandidatesSchema,
  ProjectFoldersSchema,
  ProjectMetaSchema,
  ProjectMetasSchema,
  type ProjectMetaChange,
} from '@/types/cloudProjects';
import type { CloudConnection, CloudDefaults, CloudStatus } from '@/types/cloud';
import type { RemoteAccessView } from '@/types/remoteAccess';
import {
  CloudJobSchema,
  PublicationPlanSchema,
  SyncControlResultSchema,
  SyncResultSchema,
  SyncStatusSchema,
  type SyncControlRequest,
  type ResourceRef,
  type SyncRequest,
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
  let envelope: { success?: unknown; data?: unknown; error?: unknown };
  try {
    envelope = await response.json();
  } catch {
    // The RESOURCES gate answers a plain 404 to every device but this Mac.
    throw new CloudApiError(
      response.status === 404 ? 'unavailable' : 'cloud_error',
      response.status === 404
        ? 'Cloud is available only on the Mac that runs AASC.'
        : 'Cloud action failed.',
    );
  }
  if (!response.ok || envelope.success !== true) {
    const error = envelope.error as
      | { code?: unknown; message?: unknown; details?: unknown }
      | string
      | undefined;
    throw new CloudApiError(
      typeof error === 'object' && typeof error?.code === 'string' ? error.code : 'cloud_error',
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : 'Cloud action failed.',
      typeof error === 'object' ? error.details : undefined,
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
    accountEmail: z.string().optional(),
  })
  .strict();
const status: z.ZodType<CloudStatus> = z
  .object({
    connection: connection.nullable(),
    state: z.enum(['disconnected', 'connected', 'offline', 'revoked']),
    lastError: z.string().nullable(),
  })
  .strict();
const googleStartAnswer = z.object({ url: z.string().url() }).strict();
/** How the Mac's last browser round trip ended (server/cloud/googleSignIn.ts `SignInFinish`). */
export type BrowserStepResult =
  | 'connected'
  | 'deleted'
  | 'deleted-other'
  | 'deleted-unchecked'
  | 'no-pending'
  | 'state-mismatch'
  | 'expired'
  | 'failed';
export interface BrowserStepState {
  pending: boolean;
  last: { intent: 'connect' | 'delete'; result: BrowserStepResult } | null;
}
const googleStateAnswer: z.ZodType<BrowserStepState> = z
  .object({
    pending: z.boolean(),
    last: z
      .object({
        intent: z.enum(['connect', 'delete']),
        result: z.enum([
          'connected',
          'deleted',
          'deleted-other',
          'deleted-unchecked',
          'no-pending',
          'state-mismatch',
          'expired',
          'failed',
        ]),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Where "Export my data" saved its file on this computer, and how big it is. */
const accountExportAnswer = z
  .object({ path: z.string().min(1).max(4096), bytes: z.number().int().nonnegative().safe() })
  .strict();
const defaults: z.ZodType<CloudDefaults> = z
  .object({ backendUrl: z.string().url(), deviceName: z.string() })
  .strict();
/**
 * One device signed in to the account (plan 18, RESOURCES → Machines). `kind`, `platform` and
 * `edition` are the backend's own short codes, or one a later backend adds; times are ms.
 */
export interface AccountDevice {
  id: string;
  name: string;
  kind: string | null;
  platform: string | null;
  edition: string | null;
  appVersion: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** This computer itself. */
  current: boolean;
}
// Not strict, and no limits of its own: the server has already read each row (server/cloud/devices.ts), and a
// client stricter than the server turns one long name into "couldn't list your devices". A field a later
// server adds is dropped.
const accountDevice: z.ZodType<AccountDevice> = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string().nullable(),
  platform: z.string().nullable(),
  edition: z.string().nullable(),
  appVersion: z.string().nullable(),
  createdAt: z.number().finite(),
  lastUsedAt: z.number().finite().nullable(),
  current: z.boolean(),
});
/** Each row is read on its own: one that cannot be read is left out, never a failure of the list. */
const accountDevicesAnswer = z.object({ devices: z.array(z.unknown()) }).transform(({ devices }) => ({
  devices: devices.flatMap((row) => {
    const read = accountDevice.safeParse(row);
    return read.success ? [read.data] : [];
  }),
}));
// Remote access (AASC-60) is this Mac's own Tailscale state, answered with no cloud connection and
// so with no account binding. Like `status`, the view is strict: a field the server grows later
// (an auth URL, a confirm code) is added here on purpose and never reaches the page by accident.
const remoteTailscale = z
  .object({
    state: z.enum(['not-installed', 'not-running', 'signed-out', 'stopped', 'connected']),
    address: z.string().nullable(),
    account: z.string().nullable(),
    tailnet: z.string().nullable(),
    dnsName: z.string().nullable(),
    canOpenApp: z.boolean(),
  })
  .strict();
const remotePublish = z
  .object({
    state: z.enum([
      'unavailable',
      'no-cloud',
      'not-needed',
      'no-tailscale',
      'pending',
      'published',
      'forbidden',
      'unsupported',
      'failed',
    ]),
    tailnet: z.string().nullable(),
    port: z.number().int().positive(),
    at: z.number().nullable(),
  })
  .strict();
const remotePhone = z
  .object({
    id: z.string(),
    label: z.string(),
    platform: z.enum(['ios', 'android']),
    status: z.enum(['pending', 'active']),
    hasTailnet: z.boolean(),
    tailnetSentAt: z.number().nullable(),
    lastPath: z.enum(['lan', 'tailnet']).nullable(),
    lastPathAt: z.number().nullable(),
  })
  .strict();
export const RemoteAccessViewSchema: z.ZodType<RemoteAccessView> = z
  .object({
    tailscale: remoteTailscale,
    publish: remotePublish,
    phones: z.array(remotePhone),
    port: z.number().int().positive(),
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
  /** `localPath`: a new project saved from this folder is linked to it here (the path stays local). */
  saveProject: (
    mutation: z.infer<typeof ProjectMutationSchema>,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
    localPath?: string,
  ) =>
    request(
      mutation.baseVersion === null ? '/projects' : `/projects/${uuid(mutation.value.id)}`,
      mutation.baseVersion === null ? 'POST' : 'PUT',
      binding,
      {
        ...ProjectMutationSchema.parse(mutation),
        ...(localPath && mutation.baseVersion === null ? { localPath } : {}),
      },
      ProjectRecordSchema,
      signal,
    ),
  // AASC-63: GitHub accounts, this Mac's GitHub folders, Check, Push, Remove, account choice.
  githubAccounts: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/projects/github-accounts', 'GET', binding, undefined, GithubAccountsSchema, signal),
  projectCandidates: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/projects/candidates', 'GET', binding, undefined, ProjectCandidatesSchema, signal),
  // Oct 29 2026: every project folder on this Mac, most used first, and saved projects' ♥ and tags.
  /** `null`: no connection to name; this Mac's folders still list, matched to no saved project. */
  projectFolders: (binding: CloudReviewBinding | null, signal?: AbortSignal) =>
    request(
      '/projects/folders',
      'GET',
      binding ?? undefined,
      undefined,
      ProjectFoldersSchema,
      signal,
    ),
  projectMeta: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/projects/meta', 'GET', binding, undefined, ProjectMetasSchema, signal),
  changeProjectMeta: (
    id: string,
    change: ProjectMetaChange,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request(`/projects/${uuid(id)}/meta`, 'POST', binding, change, ProjectMetaSchema, signal),
  removeProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/remove`, 'POST', binding, {}, ProjectRecordSchema, signal),
  /** `auto`: the tab's own check on opening; this Mac skips a fetch made in the last 10 minutes. */
  checkProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal, auto = false) =>
    request(
      `/projects/${uuid(id)}/check`,
      'POST',
      binding,
      auto ? { auto: true } : {},
      LocalProjectSchema,
      signal,
    ),
  pushProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/push`, 'POST', binding, {}, CloudJobSchema, signal),
  setProjectAccount: (
    id: string,
    login: string | null,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) =>
    request(`/projects/${uuid(id)}/account`, 'PUT', binding, { login }, LocalProjectSchema, signal),
  getProject: (
    id: string,
    input: z.input<typeof GetProjectSchema>,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request(`/projects/${uuid(id)}/get`, 'POST', binding, input, CloudJobSchema, signal),
  pullProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/pull`, 'POST', binding, {}, CloudJobSchema, signal),
  localProject: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/projects/${uuid(id)}/local`, 'GET', binding, undefined, LocalProjectSchema, signal),
  /** Use this folder for a saved project here: two folders had its repository and branch. */
  associateProject: (id: string, path: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(
      `/projects/${uuid(id)}/associate`,
      'POST',
      binding,
      { path },
      LocalProjectSchema,
      signal,
    ),
  status: (signal?: AbortSignal) => request('/status', 'GET', undefined, undefined, status, signal),
  defaults: (signal?: AbortSignal) =>
    request('/defaults', 'GET', undefined, undefined, defaults, signal),
  /** Sign in with Google (AASC-61): the backend URL to open in the browser; the Mac then waits for its callback. */
  /**
   * `intent: 'delete'` (plan 18) starts the round trip that deletes the account instead: it needs
   * the reviewed `binding`, and the Mac sends it to that connection's backend only.
   */
  googleStart: (
    input: { deviceName?: string; backendUrl?: string; intent?: 'delete' },
    signal?: AbortSignal,
    binding?: CloudReviewBinding,
  ) => request('/google/start', 'POST', binding, input, googleStartAnswer, signal),
  /** Whether a browser round trip is still waiting on the Mac, and how the last one ended. */
  googleState: (signal?: AbortSignal) =>
    request('/google/state', 'GET', undefined, undefined, googleStateAnswer, signal),
  /** Plan 18: saves everything AASC Cloud holds for the account to a file on this computer. */
  accountExport: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/account/export', 'POST', binding, {}, accountExportAnswer, signal),
  /** Plan 18: every device signed in to the account, this computer first, then most recently used. */
  accountDevices: (signal?: AbortSignal) =>
    request('/account/devices', 'GET', undefined, undefined, accountDevicesAnswer, signal),
  /**
   * Sign one of them out, under the connection the page reviewed. Sends `{}` as the other cloud writes do;
   * this route does not ask for a body (its router is mounted ahead of the JSON gate), and does not mind one.
   */
  signOutAccountDevice: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(
      `/account/devices/${encodeURIComponent(id)}`,
      'DELETE',
      binding,
      {},
      z.object({ revoked: z.literal(true) }),
      signal,
    ),
  googleCancel: async (signal?: AbortSignal) => {
    await request(
      '/google/cancel',
      'POST',
      undefined,
      {},
      z.object({ pending: z.literal(false) }).strict(),
      signal,
    );
  },
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
  // Remote access carries no account binding: it is this Mac's Tailscale and works with no cloud
  // connection. Its POSTs send `{}` because the server answers 415 to a write without a JSON body.
  remoteAccess: (signal?: AbortSignal) =>
    request('/remote-access', 'GET', undefined, undefined, RemoteAccessViewSchema, signal),
  refreshRemoteAccess: (signal?: AbortSignal) =>
    request('/remote-access/refresh', 'POST', undefined, {}, RemoteAccessViewSchema, signal),
  // A bare `{ success: true }`: whatever else the answer carries is not read.
  openTailscale: (signal?: AbortSignal) =>
    request(
      '/remote-access/open-tailscale',
      'POST',
      undefined,
      {},
      z.unknown().transform(() => undefined),
      signal,
    ),
  buildPublicationPlan: (
    selection: ResourceSelection,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
  ) => request('/publish-plans', 'POST', binding, { selection }, PublicationPlanSchema, signal),
  /** `skipBlocked`: save the reviewed items and leave out the ones the review blocked. */
  publishPlan: (
    id: string,
    binding: CloudReviewBinding,
    signal?: AbortSignal,
    options: { skipBlocked?: boolean } = {},
  ) =>
    request(
      `/publish-plans/${uuid(id)}/run`,
      'POST',
      binding,
      options.skipBlocked ? { skipBlocked: true } : {},
      CloudJobSchema,
      signal,
    ),
  // AASC-62: the sync list and Sync now.
  syncStatus: (binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/sync-status', 'GET', binding, undefined, SyncStatusSchema, signal),
  syncNow: (input: SyncRequest, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/sync-now', 'POST', binding, input, SyncResultSchema, signal),
  /** Oct 23 2026: Stop syncing on this Mac, Sync again, or Remove from cloud (one resource). */
  syncControl: (input: SyncControlRequest, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/sync-control', 'POST', binding, input, SyncControlResultSchema, signal),
  download: (ref: ResourceRef, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request('/downloads', 'POST', binding, ref, CloudJobSchema, signal),
  async downloadFile(id: string, binding: CloudReviewBinding, signal?: AbortSignal) {
    const response = await fetch(`/api/resources/cloud/downloads/${uuid(id)}/file`, {
      headers: cloudBindingHeaders(binding),
      signal,
    });
    if (!response.ok) {
      // A plain 404 (another device, the RESOURCES gate) has no JSON body.
      const envelope = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
      } | null;
      const code = envelope?.error?.code,
        message = envelope?.error?.message;
      throw new CloudApiError(
        typeof code === 'string' ? code : 'download_failed',
        typeof message === 'string' ? message : 'Prepared download unavailable.',
      );
    }
    return response.blob();
  },
  // A job is this Mac's local state, but it belongs to one account: the server answers 404 for
  // a job that isn't the bound account's, so these carry the binding like every other call.
  job: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/jobs/${uuid(id)}`, 'GET', binding, undefined, CloudJobSchema, signal),
  cancel: (id: string, binding: CloudReviewBinding, signal?: AbortSignal) =>
    request(`/jobs/${uuid(id)}/cancel`, 'POST', binding, {}, CloudJobSchema, signal),
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
