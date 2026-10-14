/**
 * `/api/resources/sync` — mounted inside the Resources router, after its loopback +
 * Host/Origin gate. Every non-GET needs JSON and a same-origin request, as Transfers.
 * Paths are not redacted (git pack names are 40-hex and would be mangled); file
 * contents never pass through here except as a redacted diff.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import log from '../logger.js';
import { redactSecretsInString } from '../resourceMask.js';
import { SyncError, type SyncService } from './service.js';

const id = z.string().uuid();
const excludes = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((p) => !p.startsWith('!') && !/[\x00-\x1f]/.test(p), 'Invalid pattern'),
  )
  .max(200);
const linkSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    projectId: z.string().min(1).max(128),
    deviceId: id,
    remoteRoot: z.string().min(2).max(4096),
    excludes,
    credentialsAck: z.boolean(),
  })
  .strict();
const updateSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), excludes: excludes.optional() })
  .strict();
const change = z.enum([
  'same',
  'add',
  'change',
  'delete',
  'drift',
  'conflict',
  'extra',
  'different',
  'blocked',
]);
const action = z.enum(['push', 'delete-device', 'keep', 'skip']);
const decisionSchema = z
  .object({
    entries: z
      .record(id, action)
      .refine((r) => Object.keys(r).length <= 500, 'At most 500 entries per request')
      .optional(),
    groups: z.record(z.string().min(1).max(4096), z.enum(['sync', 'overwrite', 'skip'])).optional(),
    bulk: z.object({ change, action }).strict().optional(),
  })
  .strict();
const runSchema = z.object({ confirmLiveSessions: z.boolean().optional() }).strict();
const pageSchema = z.object({
  filter: z.enum(['all', 'changes', 'decisions', 'credentials', 'links', 'failed']).optional(),
  group: z.string().max(4096).optional(),
  offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export function createSyncRouter(
  service: SyncService,
  sameOrigin: (req: Request) => boolean,
): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (req.method !== 'GET') {
      if (!req.is('application/json')) {
        res.status(415).json({ success: false, error: 'JSON body required' });
        return;
      }
      if (!sameOrigin(req)) {
        res.status(403).json({ success: false, error: 'Same-origin request required' });
        return;
      }
    }
    next();
  });
  const ok = (res: Response, data: unknown) => res.json({ success: true, data });

  router.get('/', async (_req, res) => ok(res, await service.overview()));
  router.post('/links', async (req, res) =>
    ok(res, await service.createLink(linkSchema.parse(req.body))),
  );
  router.post('/links/:id/update', async (req, res) =>
    ok(res, await service.updateLink(id.parse(req.params.id), updateSchema.parse(req.body))),
  );
  router.post('/links/:id/remove', async (req, res) => {
    await service.removeLink(id.parse(req.params.id));
    ok(res, null);
  });
  router.post('/links/:id/compare', async (req, res) =>
    ok(res, await service.compare(id.parse(req.params.id))),
  );
  router.get('/runs/:id', async (req, res) =>
    ok(res, await service.getRun(id.parse(req.params.id))),
  );
  router.get('/runs/:id/entries', async (req, res) => {
    const q = pageSchema.parse({
      filter: one(req.query.filter),
      group: one(req.query.group),
      offset: one(req.query.offset),
      limit: one(req.query.limit),
    });
    ok(res, await service.entries(id.parse(req.params.id), q));
  });
  router.get('/runs/:id/entries/:entryId/diff', async (req, res) =>
    ok(res, await service.diff(id.parse(req.params.id), id.parse(req.params.entryId))),
  );
  router.post('/runs/:id/decisions', async (req, res) =>
    ok(res, await service.decide(id.parse(req.params.id), decisionSchema.parse(req.body))),
  );
  router.post('/runs/:id/run', async (req, res) =>
    ok(res, await service.run(id.parse(req.params.id), runSchema.parse(req.body))),
  );
  router.post('/runs/:id/cancel', async (req, res) =>
    ok(res, await service.cancel(id.parse(req.params.id))),
  );
  router.post('/runs/:id/undo', async (req, res) =>
    ok(res, await service.undo(id.parse(req.params.id))),
  );

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Invalid project sync request. Check the fields and try again.',
      });
      return;
    }
    if (!(error instanceof SyncError)) {
      // Unexpected (SQLite, file system): the detail goes to the log, never to the browser.
      log.error('project-sync', error instanceof Error ? error.message : String(error));
      res
        .status(500)
        .json({ success: false, error: 'Project sync failed. Details are in the AASC log.' });
      return;
    }
    res.status(error.status).json({
      success: false,
      error: redactSecretsInString(error.message).slice(0, 500),
      ...(error.code ? { code: error.code } : {}),
    });
  });
  return router;
}
