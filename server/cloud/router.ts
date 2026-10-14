import { Router, json, type Request } from 'express';
import { assertCloudBinding, bindingFromHeaders } from './binding.js';
import { CloudError, type CloudConnector } from './types.js';
/** Raw/decompressed cloud JSON cap. Mount BEFORE any global JSON parser. */
export function cloudJsonParser(): import('express').RequestHandler {
  return json({ limit: '1mb' });
}

/** Mount behind Resources' local gate and ordinary AASC authentication. */
export function createCloudRouter(
  cloud: CloudConnector,
  sameOrigin: (req: Request) => boolean,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/status', (_req, res) => res.json({ success: true, data: cloud.status() }));
  router.use((req, res, next) => {
    const origin = req.get('origin');
    const browserSite = req.get('sec-fetch-site');
    let mismatchedOrigin = false;
    if (origin && !browserSite) {
      try {
        mismatchedOrigin = new URL(origin).host !== req.get('host');
      } catch {
        mismatchedOrigin = true;
      }
    }
    if (!sameOrigin(req) || mismatchedOrigin)
      return res.status(403).json({ success: false, error: 'Same-origin request required' });
    if (!req.is('application/json'))
      return res
        .status(415)
        .json({ success: false, error: 'Content-Type must be application/json' });
    next();
  });
  router.use(cloudJsonParser());
  router.post('/connect', async (req, res) =>
    res.json({ success: true, data: await cloud.connectCloud(req.body) }),
  );
  router.post('/recheck', async (req, res) => {
    assertCloudBinding(cloud, bindingFromHeaders(req));
    res.json({ success: true, data: await cloud.recheckCloud() });
  });
  router.post('/disconnect', async (req, res) => {
    if (cloud.status().connection) assertCloudBinding(cloud, bindingFromHeaders(req));
    await cloud.disconnectCloud();
    res.json({ success: true, data: cloud.status() });
  });
  router.post('/revoke', async (req, res) => {
    assertCloudBinding(cloud, bindingFromHeaders(req));
    await cloud.revokeDevice();
    res.json({ success: true, data: cloud.status() });
  });
  router.use(
    (
      error: unknown,
      _req: Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      const safe =
        error instanceof CloudError
          ? error
          : new CloudError(
              'cloud_error',
              'Cloud action failed. Check the backend and private local storage.',
            );
      res
        .status(safe.status)
        .json({ success: false, error: { code: safe.code, message: safe.message } });
    },
  );
  return router;
}
