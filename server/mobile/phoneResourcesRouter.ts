// phoneResourcesRouter.ts — the phone's GETs for More → Resources (Oct 24 2026, plan 16, P1):
//
//   GET /api/phone-resources/library                  the Library: resources it may see, their uses
//   GET /api/phone-resources/item/:id                 one resource: preview body, fields, files
//   GET /api/phone-resources/item/:id/file?path=      one file of it (masked, capped by the catalog)
//   GET /api/phone-resources/sync[?refresh=1]         Cloud sync: each saved resource's state
//   GET /api/phone-resources/projects[?refresh=1]     Projects: GitHub accounts, each project's checkout
//
// Mounted inside `/api`, after authMiddleware and the phone profile (which opens exactly these
// to a paired phone). A hidden resource and an unknown one answer the same 404. Every other
// method or sub-path falls through to the API router's 404. Nothing here writes yet.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PathSafetyError } from '../fsSafe.js';
import { ResourceLookupError } from '../resourceCatalog.js';
import log from '../logger.js';
import type { PhoneResources, PhoneViewer } from './phoneResources.js';

const NoQuery = z.object({}).strict();
const RefreshQuery = z.object({ refresh: z.literal('1').optional() }).strict();
const FileQuery = z.object({ path: z.string().min(1).max(4096).refine((p) => !p.includes('\0')) }).strict();
const ResourceId = z.string().regex(/^[a-f0-9]{16}$/);

const NOT_FOUND = { error: 'Not found' } as const;

function refuse(res: Response): void {
  res.status(400).json({ error: 'Invalid request' });
}

/** A catalog error as the desktop answers it; anything else is a logged, plain 500. */
function failed(res: Response, err: unknown): void {
  if (err instanceof PathSafetyError) {
    res.status(err.reason === 'not-found' ? 404 : 400).json({ error: err.reason === 'not-found' ? 'Not found' : 'Invalid path' });
    return;
  }
  if (err instanceof ResourceLookupError) {
    res.status(err.status).json({ error: err.status === 404 ? 'Not found' : 'Couldn’t read this resource' });
    return;
  }
  log.warn('phone-resources', `read failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  res.status(500).json({ error: 'Couldn’t read this resource' });
}

export function createPhoneResourcesRouter(resources: PhoneResources, isLocal: (req: Request) => boolean): Router {
  const router = Router();
  const viewerOf = (req: Request): PhoneViewer => ({ local: isLocal(req) });

  router.use('/phone-resources', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/phone-resources/library', (req, res) => {
    if (!NoQuery.safeParse(req.query).success) return refuse(res);
    try {
      res.json(resources.library(viewerOf(req)));
    } catch (err) {
      failed(res, err);
    }
  });

  router.get('/phone-resources/item/:id', async (req, res) => {
    const id = ResourceId.safeParse(req.params.id);
    if (!id.success) return res.status(404).json(NOT_FOUND);
    if (!NoQuery.safeParse(req.query).success) return refuse(res);
    try {
      const detail = await resources.item(viewerOf(req), id.data);
      if (!detail) return res.status(404).json(NOT_FOUND);
      res.json(detail);
    } catch (err) {
      failed(res, err);
    }
  });

  router.get('/phone-resources/item/:id/file', async (req, res) => {
    const id = ResourceId.safeParse(req.params.id);
    if (!id.success) return res.status(404).json(NOT_FOUND);
    const query = FileQuery.safeParse(req.query);
    if (!query.success) return refuse(res);
    try {
      const file = await resources.file(viewerOf(req), id.data, query.data.path);
      if (!file) return res.status(404).json(NOT_FOUND);
      res.json(file);
    } catch (err) {
      failed(res, err);
    }
  });

  router.get('/phone-resources/sync', async (req, res) => {
    const query = RefreshQuery.safeParse(req.query);
    if (!query.success) return refuse(res);
    // Never an error page: a failed read comes back as the state, the problem and the last good list.
    res.json(await resources.sync(viewerOf(req), { refresh: query.data.refresh === '1' }));
  });

  router.get('/phone-resources/projects', async (req, res) => {
    const query = RefreshQuery.safeParse(req.query);
    if (!query.success) return refuse(res);
    res.json(await resources.projects({ refresh: query.data.refresh === '1' }));
  });

  return router;
}
