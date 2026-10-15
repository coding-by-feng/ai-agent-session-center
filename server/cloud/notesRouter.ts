import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { cloudJsonParser } from './router.js';
import { CloudError, type CloudConnector } from './types.js';
import {
  NOTE_MESSAGES,
  NOTES_HTTP_MESSAGES,
  NotesBatchSchema,
  NotesDeleteSchema,
  NotesDeleteResultSchema,
  NotesPullResultSchema,
  NotesPushResultSchema,
} from '../../src/types/skillNotesSync.js';
export const notesJsonParser = cloudJsonParser;
function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CloudError('invalid_response', 'Cloud returned an invalid notes response.');
  return parsed.data;
}
const querySchema = z
  .object({
    since: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const safeMessages: Record<string, string> = {
  ...NOTE_MESSAGES,
  ...NOTES_HTTP_MESSAGES,
  disconnected: 'Cloud is disconnected.',
  connection_changed: 'The cloud connection changed. Refresh before syncing.',
  revoked: 'Cloud authentication is no longer valid. Reconnect this device.',
  forbidden: 'This device cannot perform this notes action.',
  offline: 'Cloud is offline. Your pending notes remain on this device.',
  cancelled: 'The notes request was cancelled.',
  invalid_response: 'Cloud returned an invalid notes response.',
  backend_error: 'The cloud notes request failed.',
};
export function notesErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if ((error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: { code: 'batch_too_large', message: NOTES_HTTP_MESSAGES.batch_too_large },
    });
    return;
  }
  const code =
    error instanceof CloudError && safeMessages[error.code]
      ? error.code
      : error instanceof z.ZodError
        ? 'invalid_request'
        : 'backend_error';
  res
    .status(error instanceof CloudError ? error.status : code === 'invalid_request' ? 400 : 502)
    .json({ success: false, error: { code, message: safeMessages[code] } });
}
/** Mounted behind the REAL dashboard auth gate; no filesystem/config surface. */
export function createNotesRouter(cloud: CloudConnector): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/status', (_req, res) => {
    const s = cloud.status(),
      c = s.connection;
    res.json({
      success: true,
      data: {
        connection: c
          ? { backendOrigin: c.backendOrigin, accountId: c.accountId, generation: c.generation }
          : null,
        state: s.state,
      },
    });
  });
  // Reject unknown routes before parsing or contacting the backend.
  router.use((req, res, next) => {
    if (
      !(
        (req.method === 'GET' && (req.path === '/' || req.path === '/export')) ||
        (req.method === 'POST' && req.path === '/batch') ||
        (req.method === 'DELETE' && req.path === '/all')
      )
    )
      return res
        .status(404)
        .json({ success: false, error: { code: 'not_found', message: 'Notes route not found.' } });
    next();
  });
  router.use((req, _res, next) => {
    const connection = cloud.status().connection;
    if (!connection) throw new CloudError('disconnected', safeMessages.disconnected, 409);
    // A stale tab must never send account A's outbox through account B's server token.
    if (
      req.get('x-aasc-notes-backend') !== connection.backendOrigin ||
      req.get('x-aasc-notes-account') !== connection.accountId ||
      req.get('x-aasc-notes-generation') !== String(connection.generation)
    )
      throw new CloudError('connection_changed', safeMessages.connection_changed, 409);
    if (req.method !== 'GET') {
      const site = req.get('sec-fetch-site'),
        origin = req.get('origin');
      let mismatch = false;
      if (origin && !site) {
        try {
          mismatch = new URL(origin).host !== req.get('host');
        } catch {
          mismatch = true;
        }
      }
      if ((site && site !== 'same-origin') || mismatch)
        throw new CloudError('forbidden', safeMessages.forbidden, 403);
      if (!req.is('application/json'))
        throw new CloudError('invalid_request', NOTES_HTTP_MESSAGES.invalid_request, 415);
    }
    next();
  });
  router.use(notesJsonParser());
  const forward = (req: Request, res: Response, method: string, path: string, body?: unknown) => {
    const c = cloud.status().connection;
    if (
      !c ||
      req.get('x-aasc-notes-backend') !== c.backendOrigin ||
      req.get('x-aasc-notes-account') !== c.accountId ||
      req.get('x-aasc-notes-generation') !== String(c.generation)
    )
      throw new CloudError('connection_changed', safeMessages.connection_changed, 409);
    return cloud.client.request(method, path, body, signalFor(res));
  };
  const signalFor = (res: Response) => {
    const c = new AbortController();
    res.on('close', () => c.abort());
    return c.signal;
  };
  for (const path of ['/', '/export'])
    router.get(path, async (req, res) => {
      const q = querySchema.parse(req.query),
        params = new URLSearchParams({ limit: String(q.limit ?? 100) });
      if (q.since) params.set('since', q.since);
      const data = parseResponse(
        NotesPullResultSchema,
        await forward(req, res, 'GET', `/v1/skill-notes${path === '/' ? '' : path}?${params}`),
      );
      res.json({ success: true, data });
    });
  router.post('/batch', async (req, res) => {
    const body = NotesBatchSchema.parse(req.body);
    if (new Set(body.ops.map((o) => o.mutationId)).size !== body.ops.length)
      throw new CloudError('invalid_request', NOTES_HTTP_MESSAGES.invalid_request, 400);
    const data = parseResponse(
      NotesPushResultSchema,
      await forward(req, res, 'POST', '/v1/skill-notes/batch', body),
    );
    if (
      data.results.length !== body.ops.length ||
      data.results.some(
        (r, i) =>
          r.mutationId !== body.ops[i].mutationId ||
          ('record' in r && r.record.key !== body.ops[i].key),
      )
    )
      throw new CloudError('invalid_response', safeMessages.invalid_response);
    res.json({ success: true, data });
  });
  router.delete('/all', async (req, res) => {
    const body = NotesDeleteSchema.parse(req.body),
      data = parseResponse(
        NotesDeleteResultSchema,
        await forward(req, res, 'DELETE', '/v1/skill-notes/all', body),
      );
    if (data.mutationId !== body.mutationId)
      throw new CloudError('invalid_response', safeMessages.invalid_response);
    res.json({ success: true, data });
  });
  router.use(notesErrorHandler);
  return router;
}
