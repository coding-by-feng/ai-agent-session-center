import { Router, json, type Request } from 'express';
import { z } from 'zod';
import {
  ProjectMutationSchema,
  GetProjectSchema,
  GithubLoginSchema,
} from '../../src/types/cloudProjects.js';
import { ResourceDependencySchema } from '../../src/types/cloudResources.js';
import { bindingFromHeaders, optionalBindingFromHeaders } from './binding.js';
import { CloudError } from './types.js';
import { LocalPathSchema } from './projectPaths.js';
import type { ProjectJobs } from './projectJobs.js';
const empty = z.object({}).strict(),
  id = z.uuid();
export function createProjectRouter(
  getService: () => Promise<ProjectJobs>,
  sameOrigin: (req: Request) => boolean,
) {
  const router = Router();
  router.use((req, res, next) => {
    if (!/^\/(?:projects)(?:\/|$)/.test(req.path)) return next('router');
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

  router.get('/projects', async (req, res) => {
    const query = z
      .object({ cursor: id.optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
      .strict()
      .parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).listProjects(query, bindingFromHeaders(req)),
    });
  });
  // AASC-63: the GitHub CLI's accounts (logins only) and this device's GitHub folders. Both are
  // matched before `/projects/:id`, whose id must be a UUID.
  router.get('/projects/github-accounts', async (req, res) => {
    empty.parse(req.query);
    bindingFromHeaders(req);
    res.json({ success: true, data: await (await getService()).githubAccounts() });
  });
  router.get('/projects/candidates', async (req, res) => {
    empty.parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).candidates(bindingFromHeaders(req)),
    });
  });
  // Oct 29 2026: every project folder on this device, most used first, and saved projects' ♥/tags.
  // The folders list with no connection too (no binding headers): they are this Mac's own.
  router.get('/projects/folders', async (req, res) => {
    empty.parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).folders(optionalBindingFromHeaders(req)),
    });
  });
  router.get('/projects/meta', async (req, res) => {
    empty.parse(req.query);
    res.json({
      success: true,
      data: await (await getService()).projectMeta(bindingFromHeaders(req)),
    });
  });
  router.post('/projects/:id/meta', async (req, res) => {
    res.json({
      success: true,
      data: await (
        await getService()
      ).changeProjectMeta(id.parse(req.params.id), req.body, bindingFromHeaders(req)),
    });
  });
  router.post('/projects', async (req, res) => {
    // A save from a folder on this device links it here; the path itself never leaves the Mac.
    const { localPath, ...mutation } = z
      .object({ localPath: LocalPathSchema.optional() })
      .passthrough()
      .parse(req.body);
    const body = ProjectMutationSchema.parse(mutation);
    if (body.baseVersion !== null)
      throw new CloudError('invalid_request', 'Create requires an empty base revision.', 400);
    res.json({
      success: true,
      data: await (
        await getService()
      ).saveProject(body, bindingFromHeaders(req), localPath ? { path: localPath } : undefined),
    });
  });
  router.put('/projects/:id', async (req, res) => {
    const body = ProjectMutationSchema.parse(req.body);
    if (body.value.id !== id.parse(req.params.id) || body.baseVersion === null)
      throw new CloudError('invalid_request', 'Use the reviewed project and revision.', 400);
    res.json({
      success: true,
      data: await (await getService()).saveProject(body, bindingFromHeaders(req)),
    });
  });
  router.get('/projects/:id', async (req, res) =>
    res.json({
      success: true,
      data: await (await getService()).getRecord(id.parse(req.params.id), bindingFromHeaders(req)),
    }),
  );
  router.post('/projects/:id/associate', async (req, res) => {
    const body = z.object({ path: LocalPathSchema }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).associateProject(id.parse(req.params.id), body.path, bindingFromHeaders(req)),
    });
  });
  router.post('/projects/:id/get', async (req, res) => {
    const body = GetProjectSchema.parse(req.body);
    LocalPathSchema.parse(body.parentPath);
    res.json({
      success: true,
      data: await (
        await getService()
      ).getProject(id.parse(req.params.id), body, bindingFromHeaders(req)),
    });
  });
  router.post('/projects/:id/remove', async (req, res) => {
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).removeProject(id.parse(req.params.id), bindingFromHeaders(req)),
    });
  });
  router.post('/projects/:id/check', async (req, res) => {
    // `auto`: the Projects tab opening; it skips a fetch made here in the last 10 minutes.
    const body = z.object({ auto: z.boolean().optional() }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).checkProject(id.parse(req.params.id), bindingFromHeaders(req), { auto: body.auto }),
    });
  });
  router.post('/projects/:id/push', async (req, res) => {
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).pushProject(id.parse(req.params.id), bindingFromHeaders(req)),
    });
  });
  router.put('/projects/:id/account', async (req, res) => {
    const body = z.object({ login: GithubLoginSchema.nullable() }).strict().parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).setAccount(id.parse(req.params.id), body.login, bindingFromHeaders(req)),
    });
  });
  router.post('/projects/:id/pull', async (req, res) => {
    empty.parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).pullProject(id.parse(req.params.id), bindingFromHeaders(req)),
    });
  });
  router.get('/projects/:id/local', async (req, res) =>
    res.json({
      success: true,
      data: await (
        await getService()
      ).localProject(id.parse(req.params.id), bindingFromHeaders(req)),
    }),
  );
  router.post('/projects/jobs/:id/resources-plan', async (req, res) => {
    const body = z
      .object({ resourceVersions: z.array(ResourceDependencySchema).max(2000).optional() })
      .strict()
      .parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).resourcePlan(id.parse(req.params.id), bindingFromHeaders(req), body.resourceVersions),
    });
  });
  router.post('/projects/jobs/:id/retry-resources', async (req, res) => {
    const body = z
      .object({
        review: z
          .object({
            planId: id,
            decisions: z.record(id, z.enum(['keep-local', 'replace-with-backup', 'skip'])),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    res.json({
      success: true,
      data: await (
        await getService()
      ).retryResources(id.parse(req.params.id), bindingFromHeaders(req), body.review),
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
                ? 'Invalid cloud project request.'
                : 'Cloud project operation failed. Review the connection and local state.',
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
