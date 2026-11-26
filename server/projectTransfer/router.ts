/**
 * /api/project-transfer — Copy / Move a project to another computer (docs/plans/project-transfer.md).
 *
 *   This computer as the SOURCE (loopback only; 404 for anyone else):
 *     POST   /plan                      { root, options } → TransferPlanInfo
 *     POST   /plan/:id/refresh          → a fresh TransferPlanInfo (same folder and options)
 *     GET    /plan/:id/items            → { root, items }
 *     GET    /plan/:id/pack?items=R     → the files' bytes, back to back
 *     POST   /plan/:id/move-check       → { root, trash: [paths] } or 409 agents_working
 *     DELETE /plan/:id
 *     GET    /moved · POST /moved       the "Moved to …" markers
 *   This computer as the TARGET, its owner (loopback only):
 *     GET    /requests                  pending Allows
 *     POST   /requests/:id/allow | /decline
 *     GET    /allowed · DELETE /allowed/:computerId   the computers allowed to send here
 *   This computer as the TARGET, the sending computer (a paired computer's session, over Tailscale
 *   or HTTPS only):
 *     POST   /incoming                  IncomingRequest → IncomingStatus
 *     GET    /incoming/:id              → IncomingStatus
 *     PUT    /incoming/:id/pack?items=R → PackResult (body: application/octet-stream)
 *     POST   /incoming/:id/commit       → CommitResult
 *     DELETE /incoming/:id
 */
import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { TransferError } from './errors.js';
import { parseRanges, packStream } from './pack.js';
import type { Receiver } from './receiver.js';
import { TransferIdSchema } from './receiver.js';
import type { createMovedLog } from './records.js';
import type { Sender } from './sender.js';

export interface ProjectTransferRouterDeps {
  sender: Sender;
  receiver: Receiver;
  moved: ReturnType<typeof createMovedLog>;
  /** This computer itself (`isLocalRequest`). */
  isLocal(req: Request): boolean;
  /** The paired computer whose session sent this request (Bearer), still allowed; null otherwise. */
  computerOf(req: Request): { id: string; label: string } | null;
  /** Did the request arrive over Tailscale, or this server's hosted HTTPS front? */
  secureChannel(req: Request): boolean;
  /** The computers allowed to send here (the owner's `aasc-server transfers`, or a dashboard). */
  allowed?: { list(): { computerId: string; label: string; allowedAt: number }[]; forget(computerId: string): boolean };
}

const str = (v: string | string[] | undefined, fallback = ''): string => (Array.isArray(v) ? v[0] ?? fallback : v ?? fallback);

const OptionsSchema = z
  .object({ memory: z.boolean(), aasc: z.boolean(), includeNodeModules: z.boolean() })
  .strict();
const PlanBodySchema = z.object({ root: z.string().min(1).max(4096), options: OptionsSchema }).strict();
const MovedBodySchema = z
  .object({ root: z.string().min(1).max(4096), computer: z.string().min(1).max(256), destination: z.string().min(1).max(4096) })
  .strict();

function send(res: Response, run: () => Promise<unknown> | unknown): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then((data) => {
      if (!res.headersSent) res.json({ success: true, data: data ?? null });
    })
    .catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof TransferError) {
        res.status(err.status).json({ success: false, error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ success: false, error: 'The transfer failed on this computer.', code: 'internal' });
    });
}

const badRequest = (message: string): TransferError => new TransferError(message, 'invalid_request', 400);

export function createProjectTransferRouter(deps: ProjectTransferRouterDeps): Router {
  const router = Router();

  // ---- this computer as the source, and its owner's side of a target ----
  const local = Router();
  local.use((req, res, next) => {
    if (deps.isLocal(req)) return next();
    res.status(404).json({ success: false, error: 'Not found' });
  });
  local.post('/plan', (req, res) =>
    send(res, async () => {
      const body = PlanBodySchema.safeParse(req.body);
      if (!body.success) throw badRequest('Choose a project folder and what to bring.');
      return deps.sender.plan(body.data.root, body.data.options);
    }),
  );
  local.post('/plan/:id/refresh', (req, res) => send(res, () => deps.sender.refresh(str(req.params.id))));
  local.get('/plan/:id/items', (req, res) => send(res, () => deps.sender.items(str(req.params.id))));
  local.get('/plan/:id/pack', async (req, res) => {
    try {
      const planId = str(req.params.id);
      const { items } = deps.sender.items(planId);
      const indexes = parseRanges(str(req.query.items as string | string[] | undefined), items.length);
      if (!indexes) throw badRequest('That pack names no files.');
      const files = deps.sender.packFiles(planId, indexes);
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(files.reduce((n, f) => n + f.size, 0)));
      Readable.from(packStream(files)).pipe(res);
    } catch (err) {
      await send(res, () => {
        throw err;
      });
    }
  });
  local.post('/plan/:id/move-check', (req, res) => send(res, () => deps.sender.moveCheck(str(req.params.id))));
  local.delete('/plan/:id', (req, res) => send(res, () => deps.sender.discard(str(req.params.id))));
  local.get('/moved', (_req, res) => send(res, () => deps.moved.list()));
  local.post('/moved', (req, res) =>
    send(res, () => {
      const body = MovedBodySchema.safeParse(req.body);
      if (!body.success) throw badRequest('Not a moved project.');
      deps.moved.add({ ...body.data, at: Date.now() });
      return null;
    }),
  );
  local.get('/allowed', (_req, res) => send(res, () => deps.allowed?.list() ?? []));
  local.delete('/allowed/:computerId', (req, res) =>
    send(res, () => {
      const id = str(req.params.computerId);
      if (!/^[\w.:-]{1,200}$/.test(id)) throw badRequest('Not a computer id.');
      if (!deps.allowed?.forget(id)) throw new TransferError('That computer is not allowed here.', 'not_allowed', 404);
      return null;
    }),
  );
  local.get('/requests', (_req, res) => send(res, () => deps.receiver.requests()));
  local.post('/requests/:id/:answer', (req, res) =>
    send(res, () => {
      const id = TransferIdSchema.safeParse(str(req.params.id));
      const answer = str(req.params.answer);
      if (!id.success || (answer !== 'allow' && answer !== 'decline')) throw badRequest('Not a transfer request.');
      return deps.receiver.answer(id.data, answer === 'allow');
    }),
  );

  // ---- this computer as the target, for the sending computer ----
  const incoming = Router();
  incoming.use((req, res, next) => {
    const computer = deps.computerOf(req);
    if (!computer) {
      res.status(403).json({ success: false, error: 'Only a paired computer can send a project here.', code: 'computer_only' });
      return;
    }
    if (!deps.secureChannel(req)) {
      res.status(403).json({ success: false, error: 'Projects are sent only over Tailscale or HTTPS.', code: 'insecure_channel' });
      return;
    }
    res.locals.computer = computer;
    next();
  });
  const computerOf = (res: Response): { id: string; label: string } => res.locals.computer as { id: string; label: string };
  const transferId = (req: Request): string => {
    const id = TransferIdSchema.safeParse(str(req.params.id));
    if (!id.success) throw badRequest('Not a transfer.');
    return id.data;
  };
  incoming.post('/', (req, res) => send(res, () => deps.receiver.begin(req.body, computerOf(res))));
  incoming.get('/:id', (req, res) => send(res, () => deps.receiver.getStatus(transferId(req), computerOf(res).id)));
  incoming.put('/:id/pack', (req, res) =>
    send(res, () =>
      deps.receiver.receivePack(transferId(req), computerOf(res).id, str(req.query.items as string | string[] | undefined), req),
    ),
  );
  incoming.post('/:id/commit', (req, res) => send(res, () => deps.receiver.commit(transferId(req), computerOf(res).id)));
  incoming.delete('/:id', (req, res) => send(res, () => deps.receiver.cancel(transferId(req), computerOf(res).id)));

  router.use('/incoming', incoming);
  router.use(local);
  return router;
}
