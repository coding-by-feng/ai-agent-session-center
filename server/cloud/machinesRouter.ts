/**
 * @module machinesRouter
 * Plan 18, stage 2: the local routes of "one account, all devices", mounted by resourceRouter.ts at
 * `/api/resources/cloud/machines`, behind its local gate and ahead of the other cloud routes.
 *
 *   GET  /            the account's computers: the backend's list, validated (cloud/machines.ts)
 *   POST /:id/ticket  body { clientKey } → { ticket, sealSecret, expiresAt } to connect to that computer
 *   GET  /settings    what this computer tells and allows its account (mobile/machineAccountSettings.ts), which
 *                     of it the environment pins, and what the directory publisher last found
 *   PUT  /settings    body: the three settings, whole, and nothing else; answers what GET answers
 *
 * For this computer's own dashboard and Electron's main process only. Every route, reads too, must come from
 * the AASC page itself or from a non-browser client on this machine: a read here asks the backend, and a
 * ticket is a credential, so a page on another localhost port gets neither. A write also has to carry JSON.
 * No backend request is made without a usable connection (409 `disconnected`).
 *
 * Every answer is `{ success, data | error: { code, message } }`, never cached, in AASC's own words: the
 * backend's text and the reason a save failed never reach the client. Nothing here logs a ticket, key or secret.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import log from '../logger.js';
import type {
  MachineAccountSettings, MachineAccountSettingsStore, PinnedSetting,
} from '../mobile/machineAccountSettings.js';
import type {
  DirectoryState, DirectoryView, MachineDirectoryPublisher,
} from '../mobile/machineDirectoryPublisher.js';
import { listAccountMachines, requestMachineTicket } from './machines.js';
import { CloudError, type CloudConnector } from './types.js';

export interface MachinesRoutesDeps {
  cloud: Pick<CloudConnector, 'client' | 'status'>;
  settings: Pick<MachineAccountSettingsStore, 'get' | 'set' | 'pinnedByEnv'>;
  /** The directory publisher, for what it last found. Omitted: a server with none reads `no-cloud`. */
  publisher?: Pick<MachineDirectoryPublisher, 'view' | 'check'>;
  /** How long a save waits for the publisher to look again before it answers `pending`. Default 3 s. */
  saveWaitMs?: number;
}

/** A save never hangs on the cloud: past this the publisher reads `pending` and the page asks again. */
const SAVE_WAIT_MS = 3_000;

/** What the settings routes answer about the directory. `published` is set only while the state is `published`. */
export interface PublisherAnswer {
  state: DirectoryState;
  published: { lan: string | null; tailnet: string | null; public: string | null; port: number } | null;
}

/** What GET and PUT /settings answer. */
export interface MachineSettingsAnswer extends MachineAccountSettings {
  /** True for a setting the environment decides, so the page greys it out. */
  pinned: Record<PinnedSetting, boolean>;
  publisher: PublisherAnswer;
}

/** Only what the account holds right now: an address from an earlier state never shows. */
function publisherAnswer(view: DirectoryView | null): PublisherAnswer {
  if (!view) return { state: 'no-cloud', published: null };
  const published = view.state === 'published' && view.port !== null
    ? { lan: view.lan, tailnet: view.tailnet, public: view.public, port: view.port }
    : null;
  return { state: view.state, published };
}

const TicketBody = z.object({ clientKey: z.string() }).strict();

const SettingsBody = z.object({
  showOnAccount: z.boolean(),
  addresses: z.object({ lan: z.boolean(), tailnet: z.boolean(), public: z.boolean() }).strict(),
  computerEnroll: z.enum(['ask', 'auto']),
}).strict();

const PINNED_BY: Record<PinnedSetting, string> = {
  showOnAccount: 'AASC_SHOW_ON_ACCOUNT',
  computerEnroll: 'AASC_COMPUTER_ACCOUNT_ENROLL',
};

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, error: { code, message, ...extra } });
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

/** A failed cloud call as an answer: a CloudError's own status, code and words, and nothing else. */
function cloudFailure(res: Response, error: unknown): void {
  const safe = error instanceof CloudError
    ? error
    : new CloudError('cloud_error', 'Cloud action failed. Check the backend and try again.');
  fail(res, safe.status, safe.code, safe.message, safe.retryAfterMs ? { retryAfter: Math.ceil(safe.retryAfterMs / 1000) } : {});
}

export function createMachinesRouter(deps: MachinesRoutesDeps, sameOrigin: (req: Request) => boolean): Router {
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req) || originMismatch(req)) {
      fail(res, 403, 'forbidden', 'Same-origin request required');
      return;
    }
    next();
  });

  const jsonOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is('application/json')) {
      fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
      return;
    }
    next();
  };

  /** False, with the 409 sent, unless there is a connection worth asking: none is made to find out. */
  function usableConnection(res: Response): boolean {
    const status = deps.cloud.status();
    if (status.connection && status.state !== 'revoked' && status.state !== 'disconnected') return true;
    fail(res, 409, 'disconnected', 'This computer isn’t signed in to AASC Cloud.');
    return false;
  }

  router.get('/', async (_req, res) => {
    if (!usableConnection(res)) return;
    try {
      res.json({ success: true, data: { machines: await listAccountMachines(deps.cloud.client) } });
    } catch (error) {
      cloudFailure(res, error);
    }
  });

  const settingsAnswer = (publisher: PublisherAnswer): MachineSettingsAnswer => {
    const pinned = deps.settings.pinnedByEnv();
    return {
      ...deps.settings.get(),
      pinned: { showOnAccount: pinned.includes('showOnAccount'), computerEnroll: pinned.includes('computerEnroll') },
      publisher,
    };
  };

  /** The publisher's next look, for at most the save's wait; `pending` when the cloud has not answered by then. */
  async function lookAgain(): Promise<PublisherAnswer> {
    if (!deps.publisher) return publisherAnswer(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.saveWaitMs ?? SAVE_WAIT_MS);
    });
    try {
      const found = await Promise.race([deps.publisher.check({ retryRefused: true }), late]);
      return found ? publisherAnswer(found) : { state: 'pending', published: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // A read starts nothing: it answers what the publisher last found.
  router.get('/settings', (_req, res) => {
    res.json({ success: true, data: settingsAnswer(publisherAnswer(deps.publisher?.view() ?? null)) });
  });

  router.put('/settings', jsonOnly, async (req, res) => {
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'invalid_input', 'Send showOnAccount, addresses { lan, tailnet, public } and computerEnroll (ask or auto).');
      return;
    }
    let outcome: ReturnType<MachinesRoutesDeps['settings']['set']>;
    try {
      outcome = deps.settings.set(parsed.data);
    } catch (err) {
      log.warn('cloud', `Could not save the account settings of this computer: ${err instanceof Error ? err.message : String(err)}`);
      fail(res, 500, 'save_failed', 'Couldn’t save the settings. Check server-config.json.');
      return;
    }
    if (!outcome.ok) {
      fail(res, 409, 'set_by_environment', `${PINNED_BY[outcome.pinned]} is set in this computer’s environment, so it decides this setting.`, { pinned: outcome.pinned });
      return;
    }
    // The save is the owner's own act: the publisher looks again at once, and the answer says what it found.
    res.json({ success: true, data: settingsAnswer(await lookAgain()) });
  });

  router.post('/:id/ticket', jsonOnly, async (req, res) => {
    const parsed = TicketBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, 'invalid_input', 'Send { clientKey }.');
      return;
    }
    if (!usableConnection(res)) return;
    try {
      // The helper checks the id and the key before anything is sent (invalid_input, 400).
      const ticket = await requestMachineTicket(deps.cloud.client, { machineId: String(req.params.id), clientKey: parsed.data.clientKey });
      res.json({ success: true, data: ticket });
    } catch (error) {
      cloudFailure(res, error);
    }
  });

  // Nothing under /machines falls through to the other cloud routers.
  router.use((_req, res) => fail(res, 404, 'not_found', 'Not found'));

  return router;
}
