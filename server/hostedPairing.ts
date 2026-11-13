import { hostedOriginAllowed } from './hostedConfig.js';
import { Router } from 'express';
import type { HostedConfig } from './hostedConfig.js';
import { authMiddleware, extractToken, getTokenLineage, getTokenHostedIdentity } from './authManager.js';
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
  let ownerIdentity = '';
  const codes = new Map<string, {code: string; expiresAt: number}>();
  const regenerated = new Map<string, number>();
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
      const owner = `${identity.sub}:${identity.ownerEpoch}:${identity.accessMode}`;
      const kind = identity.pairingKind ?? 'phone-browser';
      // Each owner/mode gets separate phone and desktop codes. Phone codes never
      // grant the broader computer profile, even if the caller changes platform.
      const admin=identity.accessMode === 'admin';
      if (!admin && ownerIdentity !== owner) {
        for(const [key,value] of codes) if(!key.startsWith('admin:')) {devices.invalidatePairingCode(value.code);codes.delete(key);regenerated.delete(key);}
        ownerIdentity = owner;
      }
      const codeKey=admin ? `admin:${identity.sub}` : kind;
      let current = codes.get(codeKey);
      // An explicit admin connect replaces only that administrator's unused code.
      if(admin && current) {devices.invalidatePairingCode(current.code);current=undefined;codes.delete(codeKey);}
      if (identity.pairingAction === 'regenerate') {
        if (Date.now() - (regenerated.get(codeKey) ?? 0) < 2000) { res.status(429).json({ error: 'Wait before regenerating' }); return; }
        if (current) devices.invalidatePairingCode(current.code);
        current = undefined; regenerated.set(codeKey, Date.now());
      }
      if (!current) {
        current = devices.createPairingCode(kind === 'desktop' ? {platform:'desktop',autoApprove:true,hostedIdentity:identity} : {platform:'phone',hostedIdentity:identity});
        codes.set(codeKey,current);
      }
      const state = current.expiresAt <= Date.now() ? 'expired' : devices.hasPairingCode(current.code) ? 'active' : 'used';
      const requestedOrigin = String(claims.aud).slice(0, -'/hosted/order-pairing'.length);
      const fragment = new URLSearchParams({v:'2',name:`VPS ${config.orderId.slice(0,8)}`,https:requestedOrigin,p:'443',mc:current.code});
      const link = kind === 'desktop' ? `https://xclaude.dev/pair#${fragment}` : `${requestedOrigin}/hosted/pair#${current.code}`;
      res.json({kind, state, link, expiresAt: current.expiresAt});
    } catch (error) {
      res.status(error instanceof TooManyPairingCodesError ? 429 : 403).json({ error: 'Pairing access refused' });
    }
  });
  // Mobile routes are mounted before generic /api auth. Pairing proof alone cannot keep a
  // cancelled/disabled order or an unavailable website authority alive.
  router.use('/api/mobile', async (req, res, next) => {
    // Identity is looked up from the server's code/device record, never accepted from the client.
    // Identification is a key-possession proof only; it cannot mint an authenticated session.
    const bound=req.path === '/identify' && typeof req.body?.tag === 'string' && typeof req.body?.nonce === 'string' ? devices.identifyIdentity(req.body.tag,req.body.nonce)
      : req.path === '/pair' && typeof req.body?.code === 'string' ? devices.pairingIdentity(req.body.code)
      : ['/challenge','/session','/unpair'].includes(req.path) && typeof req.body?.deviceId === 'string' ? devices.hostedIdentity(req.body.deviceId)
      : getTokenHostedIdentity(extractToken(req)) ?? undefined;
    const identity=bound === undefined ? currentHostedOwner(config) : bound;
    if (!(await authorizeHosted(config, identity, true))) {
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
  router.use('/api/hosted/phones', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!hostedSessionAllowed(config, req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (getTokenHostedIdentity(extractToken(req))?.accessMode === 'admin' || !getTokenLineage(extractToken(req))?.startsWith(`hosted:${config.orderId}:`)) {
      res.status(403).json({ error: 'Order owner required' });
      return;
    }
    if (
      req.method !== 'GET' &&
      (!hostedOriginAllowed(config, req.headers.origin) || !req.is('application/json'))
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
      const code = devices.createPairingCode({platform:'phone'});
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
