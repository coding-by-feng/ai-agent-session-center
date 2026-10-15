import { z } from 'zod';
import {
  AliasDeviceStatusSchema,
  AliasPreviewSchema,
  AliasStatusSchema,
  type AliasIdentity,
} from '@/types/cloudAliases';
async function request<T>(
  path: string,
  body: unknown,
  identity: AliasIdentity,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/resources/cloud/aliases/${path}`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-aasc-notes-backend': identity.backendOrigin,
      'x-aasc-notes-account': identity.accountId,
      'x-aasc-notes-generation': String(identity.generation),
    },
    body: JSON.stringify(body),
  });
  const envelope = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (!response.ok || envelope.success !== true)
    throw new Error(
      typeof envelope.error === 'string' ? envelope.error : 'Local alias request failed.',
    );
  return schema.parse(envelope.data);
}
export const cloudAliasesApi = {
  status: (key: string, i: AliasIdentity, signal?: AbortSignal) =>
    request('status', { keys: [key] }, i, AliasDeviceStatusSchema, signal),
  setEnabled: (enabled: boolean, i: AliasIdentity, signal?: AbortSignal) =>
    request('device', { enabled }, i, z.object({ enabled: z.boolean() }).strict(), signal),
  preview: (key: string, i: AliasIdentity, signal?: AbortSignal) =>
    request('preview', { keys: [key] }, i, AliasPreviewSchema, signal),
  reconcile: (key: string, reviewId: string, i: AliasIdentity, signal?: AbortSignal) =>
    request('reconcile', { keys: [key], reviewId }, i, z.array(AliasStatusSchema).max(100), signal),
};
