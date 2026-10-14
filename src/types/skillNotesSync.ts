/** Metadata-only wire contract, shared by the proxy and browser. */
import { z } from 'zod';
export interface SyncIdentity {
  backendOrigin: string;
  accountId: string;
  profileId: string;
  generation: number;
}
export interface NotesSyncState {
  state: 'off' | 'syncing' | 'offline' | 'error' | 'idle';
  pending: number;
  conflicts: number;
  lastSyncedAt: string | null;
  durable: boolean;
}
export const NOTE_MESSAGES = {
  version_conflict: 'This note changed or was deleted. Review it before retrying.',
  tag_limit_conflict: 'The merged note exceeds 12 tags. Choose which tags to keep.',
  abbreviation_conflict: 'This abbreviation is already used. Choose another abbreviation.',
  dot_conflict: 'A tag operation conflicts with existing history. Review the note.',
  invalid_tag: 'A tag is invalid. Edit it before retrying.',
  note_size_limit: 'This note has too much tag history. Review its observed tags before retrying.',
  version_limit: 'This note reached its version limit.',
  mutation_conflict: 'This edit identifier was already used for another operation.',
} as const;
export type NoteConflictCode = keyof typeof NOTE_MESSAGES;
export const NOTES_HTTP_MESSAGES = {
  invalid_cursor: 'The server history changed. Notes need a full resynchronization.',
  batch_too_large: 'This notes batch is too large.',
  invalid_request: 'The notes request is invalid.',
  rate_limited: 'Cloud requests are temporarily limited. Try again shortly.',
} as const;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const abbreviation = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,11}$/);
export const NoteKeySchema = z
  .string()
  .max(768)
  .regex(
    // Control characters are excluded on purpose: a key names a skill, never raw bytes.
    // eslint-disable-next-line no-control-regex
    /^(claude|codex|shared):[^:/\\\s\u0000-\u001f\u007f-\u009f]+(?::[^:/\\\s\u0000-\u001f\u007f-\u009f]+)?$/u,
  );
const normalizedTag = z
  .string()
  .min(1)
  .max(24)
  .refine(
    (s) =>
      s === s.normalize('NFKC').toLowerCase() &&
      /^[\p{L}\p{N}_-]+$/u.test(s) &&
      !s.startsWith('-') &&
      !s.endsWith('-') &&
      !s.includes('--'),
  );
const unique = (a: readonly string[]) => new Set(a).size === a.length;
const NoteValueSchema = z
  .object({
    fav: z.boolean(),
    tags: z.array(normalizedTag).max(12).refine(unique),
    abbr: abbreviation.optional(),
    cli: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => !v.cli || !!v.abbr);
export const NoteMutationSchema = z
  .object({
    mutationId: uuid,
    key: NoteKeySchema,
    baseVersion: version.nullable(),
    set: z
      .object({
        fav: z.boolean().optional(),
        abbr: abbreviation.nullable().optional(),
        cli: z.boolean().optional(),
      })
      .strict()
      .optional(),
    addTags: z
      .array(z.object({ tag: z.string().min(1).max(256), dot: uuid }).strict())
      .max(100)
      .optional(),
    removeTagDots: z.array(uuid).max(100).optional(),
    delete: z.literal(true).optional(),
  })
  .strict()
  .refine((v) =>
    v.delete
      ? v.set === undefined && v.addTags === undefined && v.removeTagDots === undefined
      : Object.keys(v.set ?? {}).length > 0 || !!v.addTags?.length || !!v.removeTagDots?.length,
  );
export const NoteRecordSchema = z
  .object({
    key: NoteKeySchema,
    value: NoteValueSchema,
    version,
    deleted: z.boolean(),
    tagDots: z
      .array(z.object({ tag: normalizedTag, dots: z.array(uuid).max(512).refine(unique) }).strict())
      .max(12),
  })
  .strict()
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 16 * 1024)
  .refine(
    (v) =>
      unique(v.tagDots.map((t) => t.tag)) &&
      unique(v.tagDots.flatMap((t) => t.dots)) &&
      v.tagDots.every((t) => t.dots.length > 0) &&
      JSON.stringify([...v.value.tags].sort()) ===
        JSON.stringify(v.tagDots.map((t) => t.tag).sort()),
  );
const conflictCode = z.enum(
  Object.keys(NOTE_MESSAGES) as [NoteConflictCode, ...NoteConflictCode[]],
);
export const NoteResultSchema = z.union([
  z.object({ mutationId: uuid, record: NoteRecordSchema }).strict(),
  z
    .object({
      mutationId: uuid,
      error: z.object({ code: conflictCode, message: z.string().max(2048) }).strict(),
      proposedTags: z.array(normalizedTag).min(13).max(112).refine(unique).optional(),
    })
    .strict()
    .refine((v) =>
      v.error.code === 'tag_limit_conflict' ? !!v.proposedTags : v.proposedTags === undefined,
    )
    .transform((v) => ({
      ...v,
      error: { code: v.error.code, message: NOTE_MESSAGES[v.error.code] },
    })),
]);
export const NotesBatchSchema = z
  .object({ ops: z.array(NoteMutationSchema).min(1).max(100) })
  .strict();
export const NotesPushResultSchema = z
  .object({ results: z.array(NoteResultSchema).max(100) })
  .strict();
export const NotesPullResultSchema = z
  .object({
    records: z.array(NoteRecordSchema).max(100),
    cursor: z.string().min(1).max(2048),
    hasMore: z.boolean(),
  })
  .strict();
export const NotesDeleteSchema = z.object({ mutationId: uuid }).strict();
export const NotesDeleteResultSchema = z
  .object({ mutationId: uuid, deletedCount: z.number().int().nonnegative() })
  .strict();
export const NotesStatusSchema = z
  .object({
    connection: z
      .object({
        backendOrigin: z.string().url(),
        accountId: uuid,
        generation: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    state: z.enum(['disconnected', 'connected', 'offline', 'revoked']),
  })
  .strict();
export type NoteMutation = z.infer<typeof NoteMutationSchema>;
export type NoteRecord = z.infer<typeof NoteRecordSchema>;
export type NoteResult = z.infer<typeof NoteResultSchema>;
export type NotesStatus = z.infer<typeof NotesStatusSchema>;
export type NotesPull = z.infer<typeof NotesPullResultSchema>;
export type NotesPush = z.infer<typeof NotesPushResultSchema>;
export interface StoredNoteRecord {
  id: string;
  partition: string;
  key: string;
  acknowledged: NoteRecord | null;
  projected: NoteRecord;
}
export interface StoredNoteOperation {
  id: string;
  partition: string;
  sequence: number;
  mutation: NoteMutation;
  conflict?: Exclude<NoteResult, { record: NoteRecord }>;
}
export interface StoredNoteMeta {
  partition: string;
  cursor: string | null;
  sequence: number;
  migrated?: boolean;
  importDecision?: 'separate' | 'import';
  importedFingerprint?: string;
  lastSyncedAt?: string;
  historyReset?: boolean;
  selectedIdentity?: SyncIdentity | null;
}
