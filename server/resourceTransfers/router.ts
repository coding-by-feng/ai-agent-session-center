import { Router, type Request } from 'express';
import { z } from 'zod';
import { isIP } from 'net';
import { redactStrings, redactSecretsInString } from '../resourceMask.js';
import { createTransferService, type TransferServiceDeps } from './service.js';

const id = z.string().uuid();
const deviceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    host: z
      .string()
      .min(1)
      .max(253)
      .refine((host) => isIP(host) > 0 || /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host), 'Invalid host'),
    username: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/),
    port: z.number().int().min(1).max(65535),
  })
  .strict();
const selectorSchema = z
  .object({
    include: z.boolean(),
    scope: z.enum(['global', 'project']).optional(),
    projectId: z.string().min(1).max(128).optional(),
    type: z
      .enum([
        'skill',
        'command',
        'rule',
        'instructions',
        'memory',
        'agent',
        'hook',
        'mcp',
        'plugin',
        'settings',
      ])
      .optional(),
    agent: z.enum(['claude', 'codex', 'shared']).optional(),
    resourceId: z.string().min(1).max(128).optional(),
  })
  .strict();
const draftSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    selection: z.array(selectorSchema).min(1).max(2000),
    targets: z
      .array(
        z
          .object({
            deviceId: id,
            projects: z.record(
              z.string().max(128),
              z
                .string()
                .min(1)
                .max(4096)
                .refine((p) => p.startsWith('/') && !/[\x00-\x1f]/.test(p)),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (ts) => new Set(ts.map((t) => t.deviceId)).size === ts.length,
        'Duplicate destination',
      ),
  })
  .strict();
const actionsSchema = z
  .object({ actions: z.record(id, z.enum(['add', 'replace', 'skip', 'review'])) })
  .strict();

/** Mounted AFTER the Resources loopback gate; even Compare requires same-origin JSON. */
export function createTransferRouter(
  deps: TransferServiceDeps,
  sameOrigin: (req: Request) => boolean,
): Router {
  const router = Router();
  const service = createTransferService(deps);
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
  router.get('/', async (_req, res) => {
    res.json({ success: true, data: redactStrings(await service.overview()) });
  });
  router.post('/devices', async (req, res) => {
    res.json({
      success: true,
      data: redactStrings(await service.addDevice(deviceSchema.parse(req.body))),
    });
  });
  router.post('/devices/:id/remove', async (req, res) => {
    await service.removeDevice(id.parse(req.params.id));
    res.json({ success: true, data: null });
  });
  router.post('/tasks', async (req, res) => {
    res.json({
      success: true,
      data: redactStrings(await service.saveDraft(draftSchema.parse(req.body))),
    });
  });
  for (const operation of ['compare', 'cancel', 'repeat'] as const) {
    router.post(`/tasks/:id/${operation}`, async (req, res) => {
      res.json({
        success: true,
        data: redactStrings(await service[operation](id.parse(req.params.id))),
      });
    });
  }
  router.post('/tasks/:id/run', async (req, res) => {
    res.json({
      success: true,
      data: redactStrings(
        await service.run(id.parse(req.params.id), actionsSchema.parse(req.body).actions),
      ),
    });
  });
  router.post('/tasks/:id/items/:itemId/restore', async (req, res) => {
    res.json({
      success: true,
      data: redactStrings(
        await service.restore(id.parse(req.params.id), id.parse(req.params.itemId)),
      ),
    });
  });
  router.use(
    (
      error: unknown,
      _req: Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      const message =
        error instanceof z.ZodError
          ? 'Invalid transfer request. Check the fields and try again.'
          : redactSecretsInString(error instanceof Error ? error.message : 'Transfer failed.');
      res.status(error instanceof z.ZodError ? 400 : 409).json({ success: false, error: message });
    },
  );
  return router;
}
