import { z } from 'zod';
import {
  NOTE_MESSAGES,
  NOTES_HTTP_MESSAGES,
  NotesStatusSchema,
  NotesPullResultSchema,
  NotesPushResultSchema,
  NotesDeleteResultSchema,
  type SyncIdentity,
  type NoteMutation,
} from '@/types/skillNotesSync';
const messages: Record<string, string> = {
  ...NOTE_MESSAGES,
  ...NOTES_HTTP_MESSAGES,
  offline: 'Cloud is offline. Your notes remain on this device.',
  revoked: 'Reconnect this device to sync notes.',
  forbidden: 'This device cannot sync notes.',
  connection_changed: 'The cloud connection changed. Refresh its status.',
  disconnected: 'Cloud is disconnected.',
  invalid_response: 'The notes response was invalid.',
  backend_error: 'The cloud notes request failed.',
  cancelled: 'Notes sync was cancelled.',
};
export class NotesApiError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(messages[code] ?? messages.backend_error);
  }
}
async function request<T>(
  path: string,
  method: string,
  schema: z.ZodType<T>,
  identity: SyncIdentity | null,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  try {
    const response = await fetch('/api/cloud/skill-notes' + path, {
      method,
      signal,
      headers: {
        ...(identity
          ? {
              'x-aasc-notes-backend': identity.backendOrigin,
              'x-aasc-notes-account': identity.accountId,
              'x-aasc-notes-generation': String(identity.generation),
            }
          : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new NotesApiError('invalid_response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 1024 * 1024) throw new NotesApiError('invalid_response');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new NotesApiError('invalid_response');
    }
    const envelope = json as { success?: unknown; data?: unknown; error?: { code?: unknown } };
    if (!response.ok) {
      const code = envelope.error?.code;
      throw new NotesApiError(
        response.status === 401
          ? 'revoked'
          : response.status === 403
            ? 'forbidden'
            : typeof code === 'string' && Object.hasOwn(messages, code)
              ? code
              : 'backend_error',
        response.status,
      );
    }
    if (envelope.success !== true) throw new NotesApiError('invalid_response');
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw new NotesApiError('invalid_response');
    return parsed.data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error instanceof NotesApiError) throw error;
    throw new NotesApiError('offline');
  }
}
export const cloudNotesApi = {
  status: (signal?: AbortSignal) => request('/status', 'GET', NotesStatusSchema, null, signal),
  pull: (identity: SyncIdentity, cursor: string | null, signal: AbortSignal) =>
    request(
      `?limit=100${cursor ? '&since=' + encodeURIComponent(cursor) : ''}`,
      'GET',
      NotesPullResultSchema,
      identity,
      signal,
    ),
  push: (identity: SyncIdentity, ops: NoteMutation[], signal: AbortSignal) =>
    request('/batch', 'POST', NotesPushResultSchema, identity, signal, { ops }),
  export: (identity: SyncIdentity, cursor: string | null, signal: AbortSignal) =>
    request(
      `/export?limit=100${cursor ? '&since=' + encodeURIComponent(cursor) : ''}`,
      'GET',
      NotesPullResultSchema,
      identity,
      signal,
    ),
  deleteAll: (identity: SyncIdentity, mutationId: string, signal: AbortSignal) =>
    request('/all', 'DELETE', NotesDeleteResultSchema, identity, signal, { mutationId }),
};
