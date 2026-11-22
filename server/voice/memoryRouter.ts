// memoryRouter.ts — reviewing what AASC could keep from voice calls (callMemory.ts, Nov 22 2026).
//
//   GET  /voice/memory              { items, projects }: every item but those still `watching`, and the projects the
//                                   caller may scope one to. This Mac sees all; a paired phone global items and the
//                                   projects of sessions it can see (callMemory.visibleTo)
//   POST /voice/memory/:id          { action: keep | skip | retire, scope?, meant?, supersedes? } → { item }
//   POST /voice/memory              this Mac only (a central's memory_propose): { kind, heard, meant, scope } during a
//                                   call → { item } proposed (never kept), { item, duplicate } when already asked about,
//                                   { item: null, watching } for a habit seen in one call. 409 outside a call; 422 when
//                                   `heard` is not the person's own words in it (callMemoryExtract.saidByPerson)
//
// An item, a scope or a `supersedes` the caller may not see is a 404, like a hidden session.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import log from '../logger.js';
import { MEANT_MAX, MEMORY_KINDS, checkScope, memoryKey, visibleTo, type CallMemory, type MemoryDecision } from './callMemory.js';
import { saidByPerson } from './callMemoryExtract.js';
import type { TranscriptLine } from './transcriptLog.js';

export interface MemoryRouterDeps {
  isLocal(req: Request): boolean;
  /** Project folders of the sessions this caller can see. */
  projectsFor(isLocal: boolean): string[];
  memory: CallMemory;
  /** The call in progress and its transcript so far; null when there is none. */
  liveCall(): { callId: string; lines: readonly TranscriptLine[] } | null;
}

const decideBody = z.object({
  action: z.enum(['keep', 'skip', 'retire']),
  scope: z.string().max(1100).optional(),
  meant: z.string().min(1).max(MEANT_MAX).optional(),
  supersedes: z.string().min(1).max(100).optional(),
}).strict();

const proposeBody = z.object({
  kind: z.enum(MEMORY_KINDS as [string, ...string[]]),
  heard: z.string().trim().min(1).max(400),
  meant: z.string().trim().min(1).max(MEANT_MAX),
  scope: z.string().max(1100),
}).strict();

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ success: false, code, error });
}

export function createMemoryRouter(deps: MemoryRouterDeps): Router {
  const router = Router();
  const callerOf = (req: Request) => {
    const isLocal = deps.isLocal(req);
    return { isLocal, projects: deps.projectsFor(isLocal) };
  };

  router.get('/voice/memory', (req: Request, res: Response) => {
    const caller = callerOf(req);
    res.json({ success: true, data: { items: deps.memory.list().filter((i) => visibleTo(i, caller)), projects: caller.projects } });
  });

  router.post('/voice/memory', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) { refuse(res, 404, 'not_found', 'Not found'); return; }
    const parsed = proposeBody.safeParse(req.body);
    if (!parsed.success) { refuse(res, 400, 'invalid', 'kind (preference, correction or pattern), heard, meant and scope'); return; }
    const body = { ...parsed.data, kind: parsed.data.kind as (typeof MEMORY_KINDS)[number] };
    try { checkScope(body.scope); } catch { refuse(res, 400, 'invalid', 'scope is global or project:<folder>'); return; }
    const live = deps.liveCall();
    if (!live) { refuse(res, 409, 'no_call', 'Only during a call: AASC proposes what the person said in it'); return; }
    if (!saidByPerson(body.heard, live.lines)) {
      refuse(res, 422, 'not_said', 'heard must be the person’s own words from this call, as transcribed');
      return;
    }
    const [item] = deps.memory.propose([body], live.callId);
    if (item) { res.json({ success: true, data: { item } }); return; }
    const existing = deps.memory.byKey(memoryKey(body));
    res.json({ success: true, data: existing?.status === 'watching' ? { item: null, watching: true } : { item: existing, duplicate: true } });
  });

  router.post('/voice/memory/:id', (req: Request, res: Response) => {
    const parsed = decideBody.safeParse(req.body);
    if (!parsed.success) { refuse(res, 400, 'invalid', 'action (keep, skip or retire), scope, meant or supersedes'); return; }
    const body = parsed.data;
    if (body.scope !== undefined) {
      try { checkScope(body.scope); } catch { refuse(res, 400, 'invalid', 'scope is global or project:<folder>'); return; }
    }
    const caller = callerOf(req);
    const item = deps.memory.get(String(req.params.id ?? ''));
    const hidden = (scope: string | undefined): boolean => scope !== undefined && !visibleTo({ scope }, caller);
    const old = body.supersedes ? deps.memory.get(body.supersedes) : null;
    if (!item || item.status === 'watching' || hidden(item.scope) || hidden(body.scope) || (body.supersedes && (!old || hidden(old.scope)))) {
      refuse(res, 404, 'not_found', 'Not found');
      return;
    }
    const decision: MemoryDecision = body.action === 'keep'
      ? { action: 'keep', scope: body.scope, meant: body.meant, supersedes: body.supersedes }
      : { action: body.action };
    try {
      res.json({ success: true, data: { item: deps.memory.decide(item.id, decision) } });
    } catch (err) {
      log.warn('voice', `Call memory decision failed: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, 400, 'invalid', 'Could not save that');
    }
  });

  return router;
}
