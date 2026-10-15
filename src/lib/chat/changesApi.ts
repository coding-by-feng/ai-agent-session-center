/**
 * changesApi.ts — what a session edited (AASC-44), from its own transcript:
 *
 *   GET /api/sessions/:id/changes            → { files, total, cli, truncated? }
 *   GET /api/sessions/:id/changes/:fileIndex → { path, added, removed, lastAt, hunks, … }
 *
 * `fileIndex` is a file's index in `files` (newest edit first), so it shifts when
 * the session edits again: DiffScreen finds its neighbours by path in the current
 * list, never by index ± 1, and keeps the diff it opened (it doesn't refetch it).
 *
 * A paired phone gets a secret file listed with `redacted: true` and its diff
 * without hunks (server/mobile/phoneChatFilter.ts).
 *
 * The reads are cached and kept current by stores/changesStore.ts (its hooks:
 * useSessionChanges, useFileChanges, useSessionChangesTotal).
 */
import { z } from 'zod';
import type { DiffHunk, FileChanges, SessionChanges, ChangedFile } from '@/types/chat';
import { getData, type ApiResult } from './chatApi';

/** A changed file as a phone sees it: a secret one is listed without its content. */
export type PhoneChangedFile = ChangedFile & { redacted?: boolean };
export type PhoneSessionChanges = Omit<SessionChanges, 'files'> & { files: PhoneChangedFile[] };
export type PhoneFileChanges = FileChanges & { redacted?: boolean };

const counts = { added: z.number(), removed: z.number() };
const fileSchema = z.looseObject({ path: z.string(), ...counts, lastAt: z.number(), redacted: z.boolean().optional() });
const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

const changesSchema = z.object({
  files: z.array(fileSchema),
  total: z.object(counts),
  cli: z.enum(['claude', 'codex']).nullable(),
  truncated: z.boolean().optional(),
});

const fileChangesSchema = fileSchema.extend({
  hunks: z.array(hunkSchema),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
  replaced: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

const WHAT = 'what this session changed';

export async function fetchSessionChanges(sessionId: string, signal?: AbortSignal): Promise<ApiResult<PhoneSessionChanges>> {
  const result = await getData(`/api/sessions/${encodeURIComponent(sessionId)}/changes`, signal, WHAT);
  if (!result.ok) return result;
  const parsed = changesSchema.safeParse(result.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: 200, message: 'The Mac sent changes this phone can’t read.' };
}

export async function fetchFileChanges(sessionId: string, fileIndex: number, signal?: AbortSignal): Promise<ApiResult<PhoneFileChanges>> {
  const result = await getData(`/api/sessions/${encodeURIComponent(sessionId)}/changes/${fileIndex}`, signal, WHAT);
  // The session is there but the file isn't (the list moved on): say that, not "no session".
  if (!result.ok && result.status === 404) return { ...result, message: 'This file is no longer in the session’s changes.' };
  if (!result.ok) return result;
  const parsed = fileChangesSchema.safeParse(result.data);
  return parsed.success
    ? { ok: true, data: { ...parsed.data, hunks: parsed.data.hunks as DiffHunk[] } }
    : { ok: false, status: 200, message: 'The Mac sent a diff this phone can’t read.' };
}
