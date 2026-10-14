/** A reviewed identity is always supplied by the caller; never silently refresh/retry under another account. */
import { z } from 'zod';
import type { CloudConnection, CloudStatus } from '@/types/cloud';
export type CloudReviewBinding = Pick<
  CloudConnection,
  'backendOrigin' | 'accountId' | 'generation'
>;
export class CloudApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
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
    const error = envelope.error as { code?: unknown; message?: unknown } | string | undefined;
    throw new CloudApiError(
      typeof error === 'object' && typeof error?.code === 'string' ? error.code : 'cloud_error',
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : 'Cloud action failed.',
    );
  }
  return schema.parse(envelope.data);
}
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
};
