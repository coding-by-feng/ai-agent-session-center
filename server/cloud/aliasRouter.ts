import { Router, json } from 'express';
import { z } from 'zod';
import {
  AliasIdentitySchema,
  AliasKeysSchema,
  type AliasIdentity,
} from '../../src/types/cloudAliases.js';
import { CloudError } from './types.js';
import type { CloudAliasesService } from './aliases.js';

/** Mount behind Resources/auth local gate, BEFORE the generic /cloud router. */
export function createCloudAliasesRouter(
  getService: () => Promise<CloudAliasesService>,
  sameOrigin: (req: import('express').Request) => boolean,
): import('express').Router {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const site = req.get('sec-fetch-site'),
      origin = req.get('origin');
    let mismatch = false;
    if (origin && !site) {
      try {
        mismatch = new URL(origin).host !== req.get('host');
      } catch {
        mismatch = true;
      }
    }
    if (!sameOrigin(req) || mismatch)
      return res.status(403).json({ success: false, error: 'Same-origin request required' });
    if (req.method !== 'GET' && !req.is('application/json'))
      return res
        .status(415)
        .json({ success: false, error: 'Content-Type must be application/json' });
    next();
  });
  router.use(json({ limit: '64kb' }));
  const keysSchema = z.object({ keys: AliasKeysSchema }).strict();
  const identity = (req: import('express').Request): AliasIdentity => {
    const text = req.get('x-aasc-notes-generation');
    if (!text || !/^(0|[1-9][0-9]*)$/.test(text))
      throw new CloudError(
        'connection_changed',
        'The cloud connection precondition is invalid.',
        409,
      );
    return AliasIdentitySchema.parse({
      backendOrigin: req.get('x-aasc-notes-backend'),
      accountId: req.get('x-aasc-notes-account'),
      generation: Number(text),
    });
  };
  router.post('/device', async (req, res) => {
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (await getService()).setEnabled(body.enabled, identity(req)),
    });
  });
  router.post('/status', async (req, res) => {
    const body = keysSchema.parse(req.body);
    res.json({ success: true, data: await (await getService()).status(body.keys, identity(req)) });
  });
  router.post('/preview', async (req, res) => {
    const body = keysSchema.parse(req.body);
    res.json({ success: true, data: await (await getService()).preview(body.keys, identity(req)) });
  });
  router.post('/reconcile', async (req, res) => {
    const body = z.object({ keys: AliasKeysSchema, reviewId: z.uuid() }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (await getService()).reconcile(body.keys, body.reviewId, identity(req)),
    });
  });
  router.use((_req, res) =>
    res.status(404).json({ success: false, error: 'Alias route not found' }),
  );
  router.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) =>
      res
        .status(err instanceof CloudError ? err.status : err instanceof z.ZodError ? 400 : 503)
        .json({
          success: false,
          error:
            err instanceof CloudError
              ? err.message
              : err instanceof z.ZodError
                ? 'Invalid alias request'
                : 'Local alias state is unavailable. No automatic installation was performed.',
        }),
  );
  return router;
}
