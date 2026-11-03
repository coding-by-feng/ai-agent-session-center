import { Router } from 'express';
import type { HostedConfig } from './hostedConfig.js';
import { authMiddleware, extractToken, getTokenLineage } from './authManager.js';
import { type createHostedAccess, hostedSessionAllowed } from './hostedAccess.js';
import { authorizeHosted, currentHostedOwner } from './hostedAuthority.js';
import type { createDeviceAuth } from './mobile/deviceAuth.js';
import { TooManyPairingCodesError } from './mobile/deviceAuth.js';

/** Only the order owner manages browser-phone pairing; this does not unlock localhost routes. */
export function createHostedPairingRouter(
  config: HostedConfig,
  devices: ReturnType<typeof createDeviceAuth>,
  offered = () => true,
  bridge?: Pick<ReturnType<typeof createHostedAccess>, 'inspectPairing' | 'consumePairing'>,
) {
  const router = Router();
  let current: {owner: string; code: string; expiresAt: number} | null = null;
  let lastRegenerated = 0;
  let windowStart = 0, requests = 0;
  router.post('/hosted/order-pairing', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!bridge || req.headers.origin !== config.websiteOrigin || !req.is('application/json')) {
      res.status(403).json({ error: 'Pairing access refused' }); return;
    }
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => k !== 'ticket')) {
      res.status(400).json({ error: 'Invalid pairing request' }); return;
    }
    try {
      const claims = bridge.inspectPairing(req.body.ticket);
      const now = Date.now();
      if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
      if (++requests > 30) { res.status(429).json({ error: 'Pairing requests too frequent' }); return; }
      if (!(await authorizeHosted(config, claims, true))) {
        res.status(403).json({ error: 'Pairing access refused' }); return;
      }
      const identity = bridge.consumePairing(req.body.ticket);
      if (!offered()) { res.status(409).json({ error: 'Pairing unavailable' }); return; }
      const owner = `${identity.sub}:${identity.ownerEpoch}`;
      // No awaits from ownership check through code creation: concurrent requests
      // share one current code; a replaced code is never left outstanding.
      if (current && current.owner !== owner) {
        devices.clearPairingCodes(); current = null; lastRegenerated = 0;
      }
      if (identity.pairingAction === 'regenerate') {
        if (Date.now() - lastRegenerated < 2000) { res.status(429).json({ error: 'Wait before regenerating' }); return; }
        if (current) devices.invalidatePairingCode(current.code);
        current = null; lastRegenerated = Date.now();
      }
      if (!current) current = {owner, ...devices.createPairingCode()};
      const state = current.expiresAt <= Date.now() ? 'expired' : devices.hasPairingCode(current.code) ? 'active' : 'used';
      res.json({kind: 'phone-browser', state, link: `${config.runtimeOrigin}/hosted/pair#${current.code}`, expiresAt: current.expiresAt});
    } catch (error) {
      res.status(error instanceof TooManyPairingCodesError ? 429 : 403).json({ error: 'Pairing access refused' });
    }
  });
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
