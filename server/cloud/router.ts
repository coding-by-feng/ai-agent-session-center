import { Router, json, type Request } from 'express';
import { hostname } from 'node:os';
import { assertCloudBinding, bindingFromHeaders } from './binding.js';
import { CloudError, type CloudConnector } from './types.js';
import type { GoogleSignIn } from './googleSignIn.js';
import { z } from 'zod';
/** Raw/decompressed cloud JSON cap. Mount BEFORE any global JSON parser. */
export function cloudJsonParser(): import('express').RequestHandler {
  return json({ limit: '1mb' });
}

/** The AASC Cloud backend the Connection form starts with; any other backend can still be typed. */
export const DEFAULT_CLOUD_BACKEND_URL = 'https://api.aasc.work';

/** Mount behind Resources' local gate and ordinary AASC authentication. */
/** Sign in with Google (AASC-61): the Mac's pending sign-in and the loopback URL the backend returns to. */
export interface CloudGoogleRoutes {
  signIn: GoogleSignIn;
  returnUrl: string;
}
const GoogleStartBody = z
  .object({ backendUrl: z.string().max(2048).optional(), deviceName: z.string().max(256).optional() })
  .strict();

export function createCloudRouter(
  cloud: CloudConnector,
  sameOrigin: (req: Request) => boolean,
  google?: CloudGoogleRoutes,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/status', (_req, res) => res.json({ success: true, data: cloud.status() }));
  // What the Connection form fills in before the user types: the AASC backend and this Mac's name.
  router.get('/defaults', (_req, res) =>
    res.json({
      success: true,
      data: { backendUrl: DEFAULT_CLOUD_BACKEND_URL, deviceName: hostname().replace(/\.local$/, '') },
    }),
  );
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
  if (google) {
    // The page opens the answered URL in the system browser; the backend sends it back to
    // `returnUrl` (googleCallbackRouter.ts), which finishes the pairing.
    router.post('/google/start', (req, res) => {
      const body = GoogleStartBody.safeParse(req.body ?? {});
      if (!body.success) throw new CloudError('invalid_input', 'Provide a backend URL and a device name.', 400);
      const { url } = google.signIn.begin({
        backendUrl: body.data.backendUrl || DEFAULT_CLOUD_BACKEND_URL,
        deviceName: body.data.deviceName || hostname().replace(/\.local$/, ''),
        returnUrl: google.returnUrl,
      });
      res.json({ success: true, data: { url } });
    });
    router.post('/google/cancel', (_req, res) => {
      google.signIn.cancel();
      res.json({ success: true, data: { pending: false } });
    });
  }
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
