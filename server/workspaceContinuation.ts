import { Router, type Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspaceContinuation } from '../src/types/workspaceContinuation.js';
export interface ContinuationOptions {
  directory: string;
  scope: (req: Request) => string | null;
  visible: (req: Request, sessionId: string) => boolean;
}
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:_-]+$/);
const draft = z
  .object({
    text: z.string().max(200_000),
    images: z
      .array(
        z
          .object({
            name: z.string().max(256),
            dataUrl: z
              .string()
              .max(8_000_000)
              .regex(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/),
          })
          .strict(),
      )
      .max(16),
    type: z.enum(['once', 'loop', 'schedule']),
    intervalValue: z.number().finite().min(0).max(1_000_000),
    intervalUnit: z.enum(['sec', 'min', 'hour']),
    runAt: z.string().max(64),
  })
  .strict();
const writeSchema = z
  .object({
    sourceId: id,
    selectedSessionId: id.nullable(),
    drafts: z.array(z.object({ sessionId: id, draft }).strict()).max(100),
    revision: z.number().int().nonnegative(),
    adopt: z
      .array(z.object({ sourceId: id, revision: z.number().int().positive() }).strict())
      .max(100)
      .optional(),
  })
  .strict();

/** Only continuation state: this module cannot create, restore, or close a terminal. */
export function createWorkspaceContinuationRouter(options: ContinuationOptions): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const scope = options.scope(req);
    if (!scope) {
      res.status(401).json({ error: 'Workspace sign-in required' });
      return;
    }
    res.locals.continuationScope = createHash('sha256').update(scope).digest('hex');
    next();
  });
  const fileFor = (scope: string) => join(options.directory, scope + '.json');
  function load(scope: string): WorkspaceContinuation[] {
    try {
      const data: unknown = JSON.parse(readFileSync(fileFor(scope), 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid continuation storage');
      return data.map((row) =>
        writeSchema.omit({ adopt: true }).extend({ updatedAt: z.number().finite() }).parse(row),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
  function save(scope: string, records: WorkspaceContinuation[]) {
    const serialized = JSON.stringify(records);
    if (Buffer.byteLength(serialized) > 32_000_000)
      throw new Error('Continuation capacity reached');
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const temp = fileFor(scope) + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, serialized, { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, fileFor(scope));
  }
  router.get('/', (req, res) => {
    try {
      const records = load(res.locals.continuationScope)
        .map((record) => ({
          ...record,
          selectedSessionId:
            record.selectedSessionId && options.visible(req, record.selectedSessionId)
              ? record.selectedSessionId
              : null,
          drafts: record.drafts.filter((item) => options.visible(req, item.sessionId)),
        }))
        .filter((record) => record.selectedSessionId || record.drafts.length)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ records });
    } catch {
      res
        .status(503)
        .json({ error: 'Saved continuation cannot be read. Your current workspace is unchanged.' });
    }
  });
  router.put('/', (req, res) => {
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(req.body)) > 16_000_000) {
      res.status(400).json({ error: 'Invalid or oversized continuation' });
      return;
    }
    const input = parsed.data;
    if (
      (input.selectedSessionId && !options.visible(req, input.selectedSessionId)) ||
      input.drafts.some((item) => !options.visible(req, item.sessionId))
    ) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (new Set(input.drafts.map((item) => item.sessionId)).size !== input.drafts.length) {
      res.status(400).json({ error: 'Duplicate draft session' });
      return;
    }
    try {
      const records = load(res.locals.continuationScope);
      const previous = records.find((record) => record.sourceId === input.sourceId);
      if ((previous?.revision ?? 0) !== input.revision) {
        res
          .status(409)
          .json({
            error: 'Continuation changed. Keep this draft and reconnect to review saved copies.',
          });
        return;
      }
      const current: WorkspaceContinuation = {
        sourceId: input.sourceId,
        selectedSessionId: input.selectedSessionId,
        drafts: input.drafts,
        revision: input.revision + 1,
        updatedAt: Date.now(),
      };
      const next = records
        .filter((record) => record.sourceId !== input.sourceId)
        .map((record) => {
          const adoption = input.adopt?.find(
            (item) => item.sourceId === record.sourceId && item.revision === record.revision,
          );
          const copied = record.drafts.every((item) =>
            input.drafts.some(
              (copy) =>
                copy.sessionId === item.sessionId &&
                JSON.stringify(copy.draft) === JSON.stringify(item.draft),
            ),
          );
          // Leave a revision tombstone: an original window may still be open.
          return adoption && copied ? { ...record, selectedSessionId: null, drafts: [] } : record;
        });
      next.push(current);
      if (next.filter((record) => record.selectedSessionId || record.drafts.length).length > 100) {
        res
          .status(507)
          .json({
            error: 'Too many saved window drafts. Review the saved copies before continuing.',
          });
        return;
      }
      save(res.locals.continuationScope, next);
      res.json({ revision: current.revision });
    } catch {
      res
        .status(503)
        .json({ error: 'Continuation could not be saved. Keep this window open and retry.' });
    }
  });
  return router;
}
