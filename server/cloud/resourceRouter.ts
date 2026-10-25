import { Router, json, type Request } from 'express';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { RESOURCE_TYPES } from '../../src/types/resources.js';
import {
  ResourceDependencySchema,
  SyncControlRequestSchema,
  SyncRequestSchema,
} from '../../src/types/cloudResources.js';
import { bindingFromHeaders } from './binding.js';
import { CloudError } from './types.js';
import type { ResourceJobs } from './resourceJobs.js';
const text = z.string().min(1).max(1024);
const id = z.uuid();
const empty = z.object({}).strict();
const selection = z
  .array(
    z
      .object({
        scope: z.enum(['global', 'project']).optional(),
        projectId: text.optional(),
        type: z.enum(RESOURCE_TYPES).optional(),
        agent: z.enum(['claude', 'codex', 'shared']).optional(),
        resourceId: text.optional(),
        include: z.boolean(),
      })
      .strict(),
  )
  .max(10000);
const install = ResourceDependencySchema.extend({ localProjectId: text.optional() }).strict();
const decisions = z.record(id, z.enum(['keep-local', 'replace-with-backup', 'skip']));
/** A job asked for without a usable binding is a job that does not exist. */
function jobBinding(req: Request) {
  try {
    return bindingFromHeaders(req);
  } catch {
    throw new CloudError('not_found', 'Cloud job was not found.', 404);
  }
}
/** Only local Resources mount may expose these routes. Identity headers are preconditions. */
export function createResourceJobsRouter(
  getService: () => Promise<ResourceJobs>,
  sameOrigin: (req: Request) => boolean,
) {
  const router = Router();
  router.use((req, res, next) => {
    if (
      !/^\/(?:publish-plans|install-plans|downloads|jobs|installs|resources|sync-status|sync-now|sync-control)(?:\/|$)/.test(
        req.path,
      )
    )
      return next('router');
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin'),
      site = req.get('sec-fetch-site');
    let mismatch = false;
    if (origin && !site) {
      try {
        mismatch = new URL(origin).host !== req.get('host');
      } catch {
        mismatch = true;
      }
    }
    if (!sameOrigin(req) || mismatch)
      return res.status(403).json({
        success: false,
        error: { code: 'forbidden', message: 'Same-origin request required.' },
      });
    if (req.method !== 'GET' && !req.is('application/json'))
      return res.status(415).json({
        success: false,
        error: { code: 'invalid_request', message: 'Content-Type must be application/json.' },
      });
    next();
  });
  router.use(json({ limit: '1mb' }));
  router.post('/publish-plans', async (req, res) => {
    const body = z.object({ selection }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).buildPublicationPlan(body.selection, bindingFromHeaders(req)),
    });
  });
  router.post('/publish-plans/:id/run', async (req, res) => {
    const body = z.object({ skipBlocked: z.boolean().optional() }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).publishPlan(id.parse(req.params.id), bindingFromHeaders(req), body),
    });
  });
  router.get('/sync-status', async (req, res) => {
    empty.parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).syncStatus(bindingFromHeaders(req)),
    });
  });
  router.post('/sync-now', async (req, res) =>
    res.json({
      success: true,
      data: await (
        await getService()
      ).syncNow(SyncRequestSchema.parse(req.body), bindingFromHeaders(req)),
    }),
  );
  // Oct 23 2026: Stop syncing on this Mac, Sync again, or Remove from cloud, for one resource.
  router.post('/sync-control', async (req, res) =>
    res.json({
      success: true,
      data: await (
        await getService()
      ).syncControl(SyncControlRequestSchema.parse(req.body), bindingFromHeaders(req)),
    }),
  );
  router.post('/install-plans', async (req, res) =>
    res.json({
      success: true,
      data: await (
        await getService()
      ).planInstall(install.parse(req.body), bindingFromHeaders(req)),
    }),
  );
  router.post('/install-plans/:id/run', async (req, res) => {
    const body = z.object({ decisions }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).runInstall(id.parse(req.params.id), body.decisions, bindingFromHeaders(req)),
    });
  });
  router.post('/downloads', async (req, res) =>
    res.json({
      success: true,
      data: await (
        await getService()
      ).download(ResourceDependencySchema.parse(req.body), bindingFromHeaders(req)),
    }),
  );
  router.get('/downloads/:id/file', async (req, res) => {
    const service = await getService(),
      jobId = id.parse(req.params.id);
    const path = service.downloadFile(jobId, bindingFromHeaders(req));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new CloudError('not_found', 'Prepared download is unavailable.', 404);
      throw error;
    });
    res.type('application/zip');
    res.set('Content-Disposition', 'attachment; filename="aasc-resources.zip"');
    await pipeline(file.createReadStream(), res);
    // Streamed completely: the ZIP was for this one save. An aborted save keeps it until the
    // sweep, and a HEAD (Express answers it with this GET handler) never uses it up.
    if (req.method === 'GET') await service.downloadServed(jobId);
  });
  router.get('/resources', async (req, res) => {
    const query = z
      .object({
        cursor: id.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        projectId: id.optional(),
      })
      .strict()
      .parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).listResources(query, bindingFromHeaders(req)),
    });
  });
  router.get('/jobs/:id', async (req, res) =>
    res.json({
      success: true,
      data: (await getService()).accountJob(id.parse(req.params.id), jobBinding(req)),
    }),
  );
  router.post('/jobs/:id/cancel', async (req, res) => {
    empty.parse(req.body);
    const service = await getService(),
      jobId = id.parse(req.params.id);
    service.accountJob(jobId, jobBinding(req));
    res.json({ success: true, data: service.cancel(jobId) });
  });
  router.post('/jobs/:id/retry', async (req, res) => {
    empty.parse(req.body);
    const service = await getService(),
      jobId = id.parse(req.params.id),
      binding = jobBinding(req);
    service.accountJob(jobId, binding);
    res.json({ success: true, data: await service.retry(jobId, binding) });
  });
  router.post('/installs/:id/restore', async (req, res) => {
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (await getService()).restore(id.parse(req.params.id), bindingFromHeaders(req)),
    });
  });
  router.use(
    (
      error: unknown,
      _req: Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const safe =
        error instanceof CloudError
          ? error
          : new CloudError(
              error instanceof z.ZodError ? 'invalid_request' : 'local_error',
              error instanceof z.ZodError
                ? 'Invalid cloud resource request.'
                : 'Cloud resource operation failed. Review the connection and local state.',
              error instanceof z.ZodError ? 400 : 503,
            );
      res.status(safe.status).json({
        success: false,
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.details ? { details: safe.details } : {}),
          ...(safe.retryAfterMs ? { retryAfterMs: safe.retryAfterMs } : {}),
        },
      });
    },
  );
  return router;
}
