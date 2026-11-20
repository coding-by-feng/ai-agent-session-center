/**
 * @module accountDevicesRouter
 * Plan 18, "Manage devices": the account's devices and "Sign out that device", mounted by resourceRouter.ts at
 * `/api/resources/cloud/account/devices`, behind its local gate and ahead of the other cloud routes.
 *
 *   GET    /     every live device of the account (cloud/devices.ts listAccountDevices)
 *   DELETE /:id  revoke that device at the backend: it is signed out of AASC Cloud
 *
 * For this computer's own dashboard only. Both routes, the read too, must come from the AASC page itself or
 * from a non-browser client on this machine: a read here asks the backend, and the list names every device the
 * person owns. The DELETE also needs the connection the page reviewed (the binding headers the other
 * state-changing account routes take), so a page opened under another account or an older connection cannot
 * act; it checks the id before anything is sent; and it refuses this computer's own device, which would cut the
 * token mid-call and leave the connection half-alive (signing out here is the cloud dialog's job).
 *
 * Neither says more than the backend did: the list is every page or a 502, never a part of it, and a sign-out
 * is answered, and passed to `onSignedOut`, only when the backend itself said `revoked: true`.
 *
 * Revoking is the backend's act. It ends that device's AASC Cloud sign-in. A pairing that device already holds
 * with a computer is that computer's to end: each one drops it when it next reads the account's devices
 * (mobile/accountDeviceReconcile.ts), and this one at once, through `onSignedOut`.
 *
 * Every answer is `{ success, data | error: { code, message } }`, never cached, in AASC's own words: the
 * backend's text never reaches the page, nor a device's scopes or the code that made it.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { assertCloudBinding, bindingFromHeaders } from './binding.js';
import { ACCOUNT_DEVICE_ID_RE, listAccountDevices, revokeAccountDevice } from './devices.js';
import { CloudError, type CloudConnector } from './types.js';

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/**
 * An Origin that names some other host, from a client that sent no `Sec-Fetch-Site` to say what it
 * is. A browser always sends that header, so this catches a tool pretending to be a page.
 */
function originMismatch(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin || req.get('sec-fetch-site')) return false;
  try {
    return new URL(origin).host !== req.get('host');
  } catch {
    return true;
  }
}

const NOT_CONNECTED = [409, 'not_connected', 'This computer isn’t signed in to AASC Cloud.'] as const;

/**
 * A failed call as an answer. `revoking`: the backend's "no such device" is about the device asked for;
 * on the list it could only mean a backend without the route.
 */
function refuse(res: Response, error: unknown, revoking: boolean): void {
  const code = error instanceof CloudError ? error.code : '';
  const status = error instanceof CloudError ? error.status : 0;
  // The page reviewed another connection (binding.ts): its own code and words.
  if (code === 'connection_changed') return fail(res, 409, 'connection_changed', (error as CloudError).message);
  if (code === 'invalid_input') return fail(res, 400, 'invalid_input', 'Not a device id.');
  // This computer's own token was refused, or the connection went while the call was out.
  if (code === 'disconnected' || code === 'revoked') return fail(res, ...NOT_CONNECTED);
  if (code === 'forbidden' && status === 403)
    return fail(res, 409, 'needs_sign_in', 'Sign in to AASC Cloud again on this computer to manage your devices.');
  if (revoking && status === 404 && (code === 'device_not_found' || code === 'not_found'))
    return fail(res, 404, 'device_not_found', 'That device isn’t on this AASC Cloud account any more.');
  fail(res, 502, 'cloud_unavailable', 'AASC Cloud didn’t answer. Try again.');
}

export function createAccountDevicesRouter(
  cloud: CloudConnector,
  sameOrigin: (req: Request) => boolean,
  /** Told the backend device id once the backend has confirmed its sign-out. Its faults never fail the answer. */
  onSignedOut?: (backendDeviceId: string) => void,
): Router {
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req) || originMismatch(req)) {
      fail(res, 403, 'forbidden', 'Same-origin request required');
      return;
    }
    next();
  });

  /** This computer's device id when there is a connection worth asking; else null, with the 409 sent. */
  function ownDevice(res: Response): string | null {
    const status = cloud.status();
    if (status.connection && status.state !== 'revoked' && status.state !== 'disconnected') return status.connection.deviceId;
    fail(res, ...NOT_CONNECTED);
    return null;
  }

  router.get('/', async (_req, res) => {
    const own = ownDevice(res);
    if (own === null) return;
    try {
      res.json({ success: true, data: { devices: await listAccountDevices(cloud.client, own) } });
    } catch (error) {
      refuse(res, error, false);
    }
  });

  router.delete('/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!ACCOUNT_DEVICE_ID_RE.test(id)) {
      fail(res, 400, 'invalid_input', 'Not a device id.');
      return;
    }
    const own = ownDevice(res);
    if (own === null) return;
    try {
      // The connection the page reviewed must be the one in force, before anything is said about the device.
      assertCloudBinding(cloud, bindingFromHeaders(req));
      // A device id is one device whatever its case: the stored one is only known to be a UUID.
      if (id.toLowerCase() === own.toLowerCase()) {
        fail(res, 409, 'own_device', 'Sign out of AASC Cloud on this computer instead.');
        return;
      }
      // Throws unless the backend itself said `revoked: true`: no other 2xx is a sign-out.
      await revokeAccountDevice(cloud.client, id);
      try {
        onSignedOut?.(id);
      } catch {
        // The sign-out happened; this machine's own record of that device goes at its next look instead.
      }
      res.json({ success: true, data: { revoked: true } });
    } catch (error) {
      refuse(res, error, true);
    }
  });

  // Nothing under /account/devices falls through to the other cloud routers.
  router.use((_req, res) => fail(res, 404, 'not_found', 'Not found'));

  return router;
}
