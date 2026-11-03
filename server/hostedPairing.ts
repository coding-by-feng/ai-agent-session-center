import { Router } from 'express';
import type { HostedConfig } from './hostedConfig.js';
import { authMiddleware, extractToken, getTokenLineage } from './authManager.js';
import { hostedSessionAllowed } from './hostedAccess.js';
import { authorizeHosted, currentHostedOwner } from './hostedAuthority.js';
import type { createDeviceAuth } from './mobile/deviceAuth.js';
import { TooManyPairingCodesError } from './mobile/deviceAuth.js';

/** Only the order owner manages browser-phone pairing; this does not unlock localhost routes. */
export function createHostedPairingRouter(
  config: HostedConfig,
  devices: ReturnType<typeof createDeviceAuth>,
  offered = () => true,
) {
  const router = Router();
  // Mobile routes are mounted before generic /api auth. Pairing proof alone cannot keep a
  // cancelled/disabled order or an unavailable website authority alive.
  router.use('/api/mobile', async (_req, res, next) => {
    if (!(await authorizeHosted(config, currentHostedOwner(config)))) {
      res
        .status(403)
        .json({
          error: 'Order access is unavailable. Open xclaude.dev.',
          code: 'HOSTED_AUTHORITY_REQUIRED',
        });
      return;
    }
    next();
  });
  // This adapter pairs a restricted phone browser. A code from it cannot be redeemed into
  // the paired-computer profile (which intentionally has broader access in native AASC).
  router.post('/api/mobile/pair', (req, res, next) => {
    if (req.body?.platform === 'desktop') {
      res.status(400).json({ error: 'Hosted pairing supports phone browsers only.' });
      return;
    }
    next();
  });
  router.use('/api/hosted/phones', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!hostedSessionAllowed(config, req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!getTokenLineage(extractToken(req))?.startsWith(`hosted:${config.orderId}:`)) {
      res.status(403).json({ error: 'Order owner required' });
      return;
    }
    if (
      req.method !== 'GET' &&
      (req.headers.origin !== config.runtimeOrigin || !req.is('application/json'))
    ) {
      res.status(403).json({ error: 'Same-origin JSON required' });
      return;
    }
    authMiddleware(req, res, next);
  });
  router.get('/api/hosted/phones', (_req, res) =>
    res.json({ devices: devices.list(), pairingOffered: offered() }),
  );
  router.post('/api/hosted/phones/pairing', (_req, res) => {
    if (!offered()) {
      res.status(409).json({ error: 'Phone pairing is disabled for this runtime.' });
      return;
    }
    try {
      const code = devices.createPairingCode();
      res.json({ ...code, link: `${config.runtimeOrigin}/hosted/pair#${code.code}` });
    } catch (error) {
      if (error instanceof TooManyPairingCodesError) res.status(429).json({ error: error.message });
      else throw error;
    }
  });
  router.post('/api/hosted/phones/:id/approve', (req, res) => {
    const device = devices.approve(String(req.params.id));
    if (!device) {
      res.status(404).json({ error: 'Pending phone not found' });
      return;
    }
    res.json({ device });
  });
  router.delete('/api/hosted/phones/:id', (req, res) => {
    if (!devices.deny(String(req.params.id)) && !devices.revoke(String(req.params.id))) {
      res.status(404).json({ error: 'Phone not found' });
      return;
    }
    res.json({ success: true });
  });
  return router;
}
