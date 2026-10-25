/**
 * @module chatRouter
 * The phone chat's reads of a session's conversation (AASC-41):
 *
 *   GET /api/sessions/:id/chat[?before=<cursor> | ?after=<cursor>][&limit=<1-200>]
 *     → { success: true, data: { entries, before, after, cli, hasMore, reset? } }   (src/types/chat.ts)
 *
 * No cursor gives the newest page; `before` the page above it; `after` what was written since. `limit`
 * (optional, for the MCP tools: the phone reads full pages) cuts the page to that many entries; its
 * cursors continue from them, with nothing skipped. `assistantCap=<1-20000>` (the Mac's own callers
 * only: the task ledger reads a task's answer whole) reads assistant text up to that many characters
 * per entry instead of 16 KB; everything else keeps its cap.
 *
 * And what the session edited (AASC-44), from the edit calls in that same transcript:
 *
 *   GET /api/sessions/:id/changes            → { success: true, data: { files, total, cli, truncated? } }
 *   GET /api/sessions/:id/changes/:fileIndex → { success: true, data: { path, added, removed, lastAt, hunks, … } }
 *
 * `fileIndex` is a file's index in `files` (newest edit first), so a client re-reads the list when
 * the session edits again.
 *
 * And what its context window holds (Oct 22 2026), measured from the same transcript (contextBreakdown.ts):
 *
 *   GET /api/sessions/:id/context-breakdown  → { success: true, data: ContextBreakdown | null }
 *
 * null for a Codex session (its rollout carries no per-request window), no transcript, or no request yet.
 *
 * Every page marks the tool calls that touched a secret file and their results (`secret`,
 * `callUnknown`; secretMarks.ts), judged on the calls' whole input and across pages. The content is
 * the same for everyone: the phone profile hides what a paired phone may not see by those marks, and
 * keeps a secret file in the edits list marked `redacted`, without hunks (phoneChatFilter.ts).
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
import type { ChatPage, ChangedFile, SessionChanges } from '../../src/types/chat.js';
import { isLocalRequest } from '../requestLocality.js';
import { canSeeSession } from '../sessionVisibility.js';
import log from '../logger.js';
import { readClaudeChatPage } from './claudeTranscript.js';
import { readCodexChatPage } from './codexTranscript.js';
import { ASSISTANT_TEXT_CAP_MAX } from './chatEntries.js';
import { CursorError, PAGE_ENTRIES } from './transcriptPager.js';
import { locateTranscript, transcriptCliOf, type LocatorSession } from './transcriptLocator.js';
import { buildSessionChanges } from './sessionChanges.js';
import { readContextBreakdown } from './contextBreakdown.js';
import type { ChangesSnapshot } from './changeSet.js';

export interface ChatRouterDeps {
  getSession(sessionId: string): Session | null | undefined;
  /** Is this request the Mac itself? Defaults to the server's one locality rule. */
  isLocal?(req: Request): boolean;
  /** A chat read this transcript: tell its readers when it grows (`transcriptWatch.ts`). */
  watchTranscript?(sessionId: string, path: string): void;
}

const cursor = z.string().min(1).max(64);
/** How many entries to read, 1 to a full page. Left out, the page is full (`PAGE_ENTRIES`): the phone never asks. */
const limit = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .refine((n) => n >= 1 && n <= PAGE_ENTRIES);
const pageQuery = z
  .object({ before: cursor.optional(), after: cursor.optional(), limit: limit.optional() })
  .refine((q) => q.before === undefined || q.after === undefined);

/** Characters of assistant text per entry, 1 to ASSISTANT_TEXT_CAP_MAX: only the task ledger asks. */
const assistantCap = z
  .string()
  .regex(/^\d{1,5}$/)
  .transform(Number)
  .refine((n) => n >= 1 && n <= ASSISTANT_TEXT_CAP_MAX);

const fileIndex = z.string().regex(/^\d{1,4}$/).transform(Number);

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
      res.status(400).json({
        success: false,
        error: `before and after are cursors from an earlier page, and only one is allowed; limit is a whole number from 1 to ${PAGE_ENTRIES}`,
      });
      return;
    }
    let cap: number | undefined;
    if (req.query.assistantCap !== undefined) {
      const asked = assistantCap.safeParse(req.query.assistantCap);
      if (!asked.success || !isLocal(req)) {
        const error = asked.success
          ? 'assistantCap is for AASC’s own tools on this Mac'
          : `assistantCap is a whole number from 1 to ${ASSISTANT_TEXT_CAP_MAX}`;
        res.status(400).json({ success: false, error });
        return;
      }
      cap = asked.data;
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
      const page = await read(location.path, {
        ...query.data,
        markSecrets: true,
        projectRoot: session.projectPath || null,
        ...(cap !== undefined ? { assistantCap: cap } : {}),
      });
      deps.watchTranscript?.(session.sessionId, location.path);
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

  /** The session's changes, or null when it has no transcript AASC can read. */
  async function changesOf(session: Session): Promise<ChangesSnapshot | null> {
    const location = await locateTranscript(session as LocatorSession);
    if (!location) return null;
    try {
      return await buildSessionChanges(location, session.projectPath || '');
    } catch (err) {
      if (isMissingFile(err)) return null;
      throw err;
    }
  }

  router.get('/sessions/:id/changes', visibleSession, async (_req: Request, res: Response) => {
    const session = res.locals.session as Session;
    try {
      const changes = await changesOf(session);
      const files: ChangedFile[] = (changes?.files ?? []).map(({ path, added, removed, lastAt }) => ({ path, added, removed, lastAt }));
      const data: SessionChanges = {
        files,
        total: changes?.total ?? { added: 0, removed: 0 },
        cli: transcriptCliOf(session),
        ...(changes?.truncated ? { truncated: true } : {}),
      };
      res.json({ success: true, data });
    } catch (err) {
      log.warn('api', `changes read failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read what this session changed' });
    }
  });

  router.get('/sessions/:id/context-breakdown', visibleSession, async (_req: Request, res: Response) => {
    const session = res.locals.session as Session;
    try {
      const location = await locateTranscript(session as LocatorSession);
      const data = location?.cli === 'claude'
        ? await readContextBreakdown(location.path, { projectRoot: session.projectPath || null })
        : null;
      res.json({ success: true, data });
    } catch (err) {
      log.warn('api', `context breakdown failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read what fills the context window' });
    }
  });

  router.get('/sessions/:id/changes/:fileIndex', visibleSession, async (req: Request, res: Response) => {
    const index = fileIndex.safeParse(req.params.fileIndex);
    if (!index.success) {
      res.status(400).json({ success: false, error: 'fileIndex is a file’s index in the changes list' });
      return;
    }
    try {
      const file = (await changesOf(res.locals.session as Session))?.files[index.data];
      if (!file) {
        res.status(404).json({ success: false, error: 'No such file in this session’s changes' });
        return;
      }
      res.json({ success: true, data: file });
    } catch (err) {
      log.warn('api', `changes read failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read what this session changed' });
    }
  });

  return router;
}
