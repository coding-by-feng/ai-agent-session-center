import { Router, json, type Request } from 'express';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { RESOURCE_TYPES } from '../../src/types/resources.js';
import { ResourceDependencySchema } from '../../src/types/cloudResources.js';
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
/** Only local Resources mount may expose these routes. Identity headers are preconditions. */
export function createResourceJobsRouter(
  getService: () => Promise<ResourceJobs>,
  sameOrigin: (req: Request) => boolean,
) {
  const router = Router();
  router.use((req, res, next) => {
    if (
      !/^\/(?:publish-plans|install-plans|downloads|jobs|installs|resources)(?:\/|$)/.test(req.path)
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
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).publishPlan(id.parse(req.params.id), bindingFromHeaders(req)),
    });
  });
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
    const path = (await getService()).downloadFile(
      id.parse(req.params.id),
      bindingFromHeaders(req),
    );
    res.type('application/zip');
    res.set('Content-Disposition', 'attachment; filename="aasc-resources.zip"');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    await pipeline(file.createReadStream(), res);
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
    res.json({ success: true, data: (await getService()).getJob(id.parse(req.params.id)) }),
  );
  router.post('/jobs/:id/cancel', async (req, res) => {
    empty.parse(req.body);
    res.json({ success: true, data: (await getService()).cancel(id.parse(req.params.id)) });
  });
  router.post('/jobs/:id/retry', async (req, res) => {
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (await getService()).retry(id.parse(req.params.id), bindingFromHeaders(req)),
    });
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
