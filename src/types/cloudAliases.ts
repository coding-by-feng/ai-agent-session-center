import { z } from 'zod';
import { NoteKeySchema, NotesStatusSchema } from './skillNotesSync.js';
export const AliasIdentitySchema = NotesStatusSchema.shape.connection.unwrap();
export type AliasIdentity = z.infer<typeof AliasIdentitySchema>;
export const AliasStatusSchema = z
  .object({
    key: NoteKeySchema,
    state: z.enum(['disabled', 'installed', 'needs-resource', 'conflict', 'unsupported']),
    message: z.string().max(2048).optional(),
  })
  .strict();
export type AliasStatus = z.infer<typeof AliasStatusSchema>;
export const AliasKeysSchema = z
  .array(NoteKeySchema)
  .min(1)
  .max(100)
  .refine((a) => new Set(a).size === a.length);
/** Server-derived acknowledged disclosure, never supplied by browser reconcile requests. */
export const AliasIntentSchema = z.object({
  key: NoteKeySchema,
  agent: z.enum(['claude', 'codex', 'shared']),
  target: z.string().min(1).max(768),
  abbr: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,11}$/).nullable(),
  cli: z.boolean(),
}).strict().refine(value => !value.cli || value.abbr !== null);
export type AliasIntent = z.infer<typeof AliasIntentSchema>;
export const AliasPreviewSchema = z
  .object({
    reviewId: z.uuid(),
    intents: z.array(AliasIntentSchema).min(1).max(100).refine(rows => new Set(rows.map(row => row.key)).size === rows.length),
    statuses: z.array(AliasStatusSchema).max(100),
    changes: z
      .array(
        z
          .object({
            key: NoteKeySchema,
            action: z.enum(['create', 'update', 'remove', 'retry']),
            files: z.array(z.string().max(1024)).max(4),
            message: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(200),
    cached: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
export type AliasPreview = z.infer<typeof AliasPreviewSchema>;
export const AliasDeviceStatusSchema = z
  .object({
    enabled: z.boolean(),
    connection: AliasIdentitySchema.nullable(),
    statuses: z.array(AliasStatusSchema).max(100),
    cached: z.boolean(),
  })
  .strict();
export type AliasDeviceStatus = z.infer<typeof AliasDeviceStatusSchema>;
