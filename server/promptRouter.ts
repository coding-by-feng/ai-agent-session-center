// promptRouter.ts — POST /api/sessions/:id/prompt: a prompt the Mac types and confirms (AASC-42).
//
// The phone sends intent, not bytes: the text, the ids of images it uploaded, `now`
// or `interrupt`, and a request key. The Mac builds the PTY writes itself
// (promptSubmit.ts), so control bytes in the text never reach the terminal, and only
// images it saved itself can be typed.
//
// Checked the way a terminal write is (POST /terminals/:id/write and the phone
// profile's `type` rule), before anything is typed:
//   - the session must be visible to the caller: apiRouter's own /sessions/:id gate,
//     404 for hidden and unknown alike;
//   - its agent must be the terminal's foreground program, or the text would run in
//     the shell underneath: 409 agent_not_running;
//   - `now` never types into an open dialog (approval or a question), where the text
//     could pick an option: 409 awaiting_answer (`interrupt` declines it first);
//   - a remote caller must be able to drive the session (the control baton): 423
//     control_held, with who holds it. The Mac itself is not arbitrated, as for writes.
// A paired phone's per-minute budget is the phone profile's (`prompt` rule).
//
// Then 202 at once; the send and its confirmation run in the background, and a
// repeated key answers with the first answer without sending again.
//
// Mounted in front of the main API router, so it applies the visibility gate itself.

import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import log from './logger.js';
import { isAgentProcessName } from './mobile/phoneProfile.js';
import { createPromptKeyCache, type PromptOutcome, type PromptRequest } from './promptSubmit.js';
import { SESSION_STATUS } from './constants.js';

/** What the route reads of a session. */
export interface PromptRouterSession {
  sessionId: string;
  terminalId?: string | null;
  status: string;
}

export interface PromptRouterDeps {
  /** apiRouter's /sessions/:id visibility gate. */
  requireVisibleSession: RequestHandler;
  /** Did the request come from this Mac (requestLocality)? */
  isLocal(req: Request): boolean;
  /** The device the request speaks for (bound to its sign-in), or '' for none. */
  clientIdOf(req: Request): string;
  getSession(sessionId: string): PromptRouterSession | null;
  terminalExists(terminalId: string): boolean;
  /** The terminal's foreground program (node-pty's process name), or null when unknown. */
  foregroundProcess(terminalId: string): string | null;
  /** Take or refresh the session's control baton for this device; false while another device holds it. */
  noteControlActivity(sessionId: string, clientId: string): boolean;
  /** May this device drive the session now? Never claims. */
  canControl(sessionId: string, clientId: string): boolean;
  /** Who holds the session's baton, for a refusal to name. */
  controller(sessionId: string): { label: string; online: boolean } | null;
  /** The path of an uploaded queue image, by id, or null when it is gone. */
  resolveImage(id: string): string | null;
  submitter: { submit(req: PromptRequest): Promise<PromptOutcome> };
}

/** Prompt images per send, as the phone's composer allows. */
export const MAX_PROMPT_IMAGES = 4;
export const MAX_PROMPT_TEXT = 65_536;

/** Statuses where the CLI shows a dialog: typed text would answer it. */
const DIALOG_STATUSES: ReadonlySet<string> = new Set([SESSION_STATUS.APPROVAL, SESSION_STATUS.INPUT]);

/**
 * The text as typed: line breaks as "\n" (a "\r" would press Enter mid-prompt),
 * no other control bytes (an Esc sequence could drive the TUI), trailing blanks
 * dropped as the phone's compose box does.
 */
export function cleanPromptText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
    .replace(/\s+$/, '');
}

const promptBodySchema = z.object({
  text: z.string().min(1).max(MAX_PROMPT_TEXT).transform(cleanPromptText).refine((t) => t.trim() !== '', 'Type a prompt'),
  images: z.array(z.string().max(80)).max(MAX_PROMPT_IMAGES).default([]),
  mode: z.enum(['now', 'interrupt']).default('now'),
  key: z.string().min(8).max(64).regex(/^[A-Za-z0-9._:-]+$/, 'Letters, digits and . _ : - only'),
});

const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

interface Accepted {
  success: true;
  data: { accepted: true; key: string };
}

export function createPromptRouter(deps: PromptRouterDeps): Router {
  const router = Router();
  // Keyed by the request key alone: it survives the session's re-key (term-* → the CLI's id).
  const answered = createPromptKeyCache<Accepted>();

  router.post('/sessions/:id/prompt', deps.requireVisibleSession, (req: Request, res: Response) => {
    const session = deps.getSession(str(req.params.id));
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      res.status(400).json({ success: false, error });
      return;
    }
    const { text, images, mode, key } = parsed.data;

    const first = answered.get(key);
    if (first) {
      res.status(202).json(first);
      return;
    }

    const imagePaths = images.map((id) => deps.resolveImage(id));
    if (imagePaths.some((p) => p === null)) {
      res.status(400).json({ success: false, error: 'An image is no longer on the Mac; attach it again', code: 'image_not_found' });
      return;
    }

    const terminalId = session.terminalId ?? null;
    if (!terminalId || !deps.terminalExists(terminalId) || !isAgentProcessName(deps.foregroundProcess(terminalId))) {
      res.status(409).json({ success: false, error: 'The agent is not running in this session’s terminal', code: 'agent_not_running' });
      return;
    }
    if (mode === 'now' && DIALOG_STATUSES.has(session.status)) {
      res.status(409).json({ success: false, error: 'The agent is waiting for an answer; answer it or interrupt', code: 'awaiting_answer' });
      return;
    }

    // Last, because it takes the baton: a refused request must not.
    const remote = !deps.isLocal(req);
    const clientId = remote ? deps.clientIdOf(req) : '';
    if (remote && (!clientId || !deps.noteControlActivity(session.sessionId, clientId))) {
      const holder = deps.controller(session.sessionId);
      res.status(423).json({
        success: false,
        error: 'Another device is driving this session',
        code: 'control_held',
        driver: holder ? { label: holder.label, online: holder.online } : null,
      });
      return;
    }

    const accepted: Accepted = { success: true, data: { accepted: true, key } };
    answered.set(key, accepted);
    res.status(202).json(accepted);

    log.info('prompt', `Prompt for ${session.sessionId.slice(0, 8)} accepted (${mode}, ${imagePaths.length} image(s)) from ${remote ? `device ${clientId.slice(0, 8)}` : 'this Mac'}`);
    deps.submitter.submit({
      terminalId,
      text,
      imagePaths: imagePaths as string[],
      mode,
      ...(remote ? { mayDrive: (sessionId: string) => deps.canControl(sessionId, clientId) } : {}),
    }).catch((err: unknown) => {
      log.error('prompt', `Prompt for ${session.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return router;
}
