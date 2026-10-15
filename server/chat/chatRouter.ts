/**
 * @module chatRouter
 * The phone chat's reads of a session's conversation (AASC-41):
 *
 *   GET /api/sessions/:id/chat[?before=<cursor> | ?after=<cursor>]
 *     → { success: true, data: { entries, before, after, cli, hasMore, reset? } }   (src/types/chat.ts)
 *
 * No cursor gives the newest page; `before` the page above it; `after` what was written since.
 *
 * Mounted on the `/api` chain BEFORE the main API router, so it can't lean on that router's
 * `/sessions/:id` visibility gate: each route applies the same rule itself (a remote device sees only
 * a session shared with it; hidden and unknown both answer 404, so ids can't be probed). The gate is
 * per route, never `router.use('/sessions/:id')`, which would also catch the fixed routes under
 * /sessions/ (spawn-floating, history…) that the main router gates differently.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import type { ChatPage } from '../../src/types/chat.js';
import { isLocalRequest } from '../requestLocality.js';
import { canSeeSession } from '../sessionVisibility.js';
import log from '../logger.js';
import { readClaudeChatPage } from './claudeTranscript.js';
import { readCodexChatPage } from './codexTranscript.js';
import { CursorError } from './transcriptPager.js';
import { locateTranscript, transcriptCliOf, type LocatorSession } from './transcriptLocator.js';

export interface ChatRouterDeps {
  getSession(sessionId: string): Session | null | undefined;
  /** Is this request the Mac itself? Defaults to the server's one locality rule. */
  isLocal?(req: Request): boolean;
}

const cursor = z.string().min(1).max(64);
const pageQuery = z
  .object({ before: cursor.optional(), after: cursor.optional() })
  .refine((q) => q.before === undefined || q.after === undefined);

const NOT_FOUND = { success: false, error: 'Session not found' } as const;

/** Errors that mean "the file went away between finding and reading it". */
const isMissingFile = (err: unknown): boolean =>
  !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';

export function createChatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const isLocal = deps.isLocal ?? isLocalRequest;

  /** The session, attached to `res.locals.session`, or 404 for an unknown one or one this device may not see. */
  function visibleSession(req: Request, res: Response, next: NextFunction): void {
    const session = deps.getSession(String(req.params.id));
    if (!session || !(isLocal(req) || canSeeSession(false, session))) {
      if (session) log.warn('api', `Blocked remote ${req.method} ${req.path} — session hidden`);
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.locals.session = session;
    next();
  }

  router.get('/sessions/:id/chat', visibleSession, async (req: Request, res: Response) => {
    const query = pageQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'before and after are cursors from an earlier page, and only one is allowed' });
      return;
    }
    const session = res.locals.session as Session;
    const empty: ChatPage = { entries: [], before: null, after: null, cli: transcriptCliOf(session), hasMore: false };
    try {
      const location = await locateTranscript(session as LocatorSession);
      if (!location) {
        res.json({ success: true, data: empty });
        return;
      }
      const read = location.cli === 'codex' ? readCodexChatPage : readClaudeChatPage;
      const page = await read(location.path, query.data);
      const data: ChatPage = { ...page, cli: location.cli };
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof CursorError) {
        res.status(400).json({ success: false, error: 'Not a cursor from this conversation' });
        return;
      }
      if (isMissingFile(err)) {
        res.json({ success: true, data: empty });
        return;
      }
      log.warn('api', `chat read failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read the conversation' });
    }
  });

  return router;
}
