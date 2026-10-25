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
//     the shell underneath: 409 AGENT_NOT_RUNNING (also for an ended session);
//   - a session still starting (`connecting`) may be showing a dialog that fires no
//     hook (trusting the folder): 409 agent_not_ready;
//   - `now` never types into an open dialog (approval or a question), where the text
//     could pick an option: 409 awaiting_answer (`interrupt` declines it first);
//   - one prompt may wait behind the one being typed into a terminal, no more: 409 busy;
//   - a picker-opening slash command needs its argument (`/model sonnet`): 400 needs_argument;
//   - a remote caller must be able to drive the session (the control baton): 423
//     control_held, with who holds it. The Mac itself is not arbitrated, as for writes.
//     While the send runs, a remote caller's prompt stops as soon as it may no longer
//     drive the session, the session stops being shared, or its sign-in ends.
// A paired phone's per-minute budget is the phone profile's (`prompt` rule).
//
// Then 202 at once; the send and its confirmation run in the background
// (promptSubmit.ts checks again before every keystroke). A repeated key answers with
// the first answer without sending again, unless that send ended before typing a
// thing: then the repeat sends it. The same key with a different prompt is a client
// bug and gets 409 key_reused rather than a silent drop.
//
// Mounted in front of the main API router, so it applies the visibility gate itself.

import { createHash } from 'crypto';
import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import log from './logger.js';
import { isAgentProcessName } from './mobile/phoneProfile.js';
import { createPromptKeyCache, type PromptOutcome, type PromptResult, type PromptSubmitter } from './promptSubmit.js';
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
  /**
   * For a remote caller, taken when its prompt is accepted: may that caller still
   * reach the session (still shared with remote devices, its sign-in not revoked,
   * signed out or expired)? Checked before every keystroke of the send.
   */
  remoteAccess(req: Request): (sessionId: string) => boolean;
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
  submitter: Pick<PromptSubmitter, 'submit' | 'hasRoom'>;
}

/** Prompt images per send, as the phone's composer allows (src/lib/chat/promptApi.ts; 10 since Oct 21 2026, was 4). */
export const MAX_PROMPT_IMAGES = 10;
export const MAX_PROMPT_TEXT = 65_536;

/**
 * Slash commands that open a picker, a dialog or a panel when sent with no argument
 * (Claude Code and Codex). The Mac never confirms a slash command, so the next prompt
 * would land in that picker. The phone's sheet sends them with their argument
 * (`/model sonnet`, `/effort high`), as the desktop queue's chips do.
 */
const BARE_PICKER_COMMANDS: ReadonlySet<string> = new Set([
  'model', 'effort', 'resume', 'config', 'settings', 'permissions', 'allowed-tools', 'agents', 'mcp', 'hooks',
  'memory', 'theme', 'output-style', 'add-dir', 'login', 'logout', 'export', 'status', 'help', 'doctor', 'ide',
  'plugin', 'plugins', 'rewind', 'terminal-setup', 'privacy-settings', 'install-github-app', 'bashes', 'usage',
  'context', 'feedback', 'bug', 'approvals', 'mention', 'diff',
]);

/** Is this a picker-opening slash command with no argument? */
export function isBarePickerCommand(text: string): boolean {
  const match = /^\/([A-Za-z][\w:-]*)$/.exec(text.trim());
  return !!match && BARE_PICKER_COMMANDS.has(match[1].toLowerCase());
}

/** Statuses where the CLI shows a dialog: typed text would answer it. */
const DIALOG_STATUSES: ReadonlySet<string> = new Set([SESSION_STATUS.APPROVAL, SESSION_STATUS.INPUT]);
/** Statuses where typed text reaches the input box (a busy CLI queues it). */
const SENDABLE_STATUSES: ReadonlySet<string> = new Set([
  SESSION_STATUS.WAITING, SESSION_STATUS.IDLE, SESSION_STATUS.PROMPTING, SESSION_STATUS.WORKING,
]);

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

/** A request key: what the phone names a prompt by, to retry it and to ask what became of it. */
const PROMPT_KEY_RE = /^[A-Za-z0-9._:-]+$/;

const promptBodySchema = z.object({
  text: z.string().min(1).max(MAX_PROMPT_TEXT).transform(cleanPromptText).refine((t) => t.trim() !== '', 'Type a prompt'),
  images: z.array(z.string().max(80)).max(MAX_PROMPT_IMAGES).default([]),
  mode: z.enum(['now', 'interrupt']).default('now'),
  key: z.string().min(8).max(64).regex(PROMPT_KEY_RE, 'Letters, digits and . _ : - only'),
});

const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

interface Accepted {
  success: true;
  data: { accepted: true; key: string };
}

/** Where a prompt is: still being typed and confirmed, or how it ended. */
export type PromptState = 'pending' | PromptOutcome;

/** A request key's first use: what was answered, for which session, and how the send went. */
interface KeyRecord {
  body: Accepted;
  digest: string;
  /** The id the phone used, and the session's own id at that moment (it re-keys later). */
  sessionParam: string;
  sessionId: string;
  state: PromptState;
  /** Which send of this key the record is about (a key may be sent again, see `retryable`). */
  sendId: number;
  /** The send ended before typing anything: a repeat sends it again instead of replaying. */
  retryable: boolean;
}

/**
 * What a key was first used for: a repeat must be the same request. By terminal, not
 * by the id in the path: that one changes when the session re-keys (term-* → the
 * CLI's id, a /clear), and a retry after it is still the same prompt.
 */
function requestDigest(terminalId: string, text: string, images: readonly string[], mode: string): string {
  return createHash('sha256').update(JSON.stringify([terminalId, text, images, mode])).digest('hex');
}

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ success: false, error, code });
}

export function createPromptRouter(deps: PromptRouterDeps): Router {
  const router = Router();
  // Keyed by the request key alone: it survives the session's re-key (term-* → the CLI's id).
  const answered = createPromptKeyCache<KeyRecord>();
  let sends = 0;
  // The outcome lands seconds later; keep it on the key's record (a new object: the
  // cache holds immutable values) so the phone can ask what became of its prompt.
  const settle = (key: string, sendId: number, result: PromptResult): void => {
    const record = answered.get(key);
    if (!record || record.sendId !== sendId) return;
    const retryable = !result.typed && (result.outcome === 'stopped' || result.outcome === 'failed');
    answered.set(key, { ...record, state: result.outcome, retryable });
  };
  // Does this key belong to the session the caller named? Either the id it was sent
  // with, or the same session after a re-key (term-* → the CLI's id).
  const belongsTo = (record: KeyRecord, sessionParam: string): boolean => {
    if (record.sessionParam === sessionParam || record.sessionId === sessionParam) return true;
    const now = deps.getSession(sessionParam);
    const then = deps.getSession(record.sessionParam);
    return !!now && !!then && now.sessionId === then.sessionId;
  };

  router.get('/sessions/:id/prompt/:key', deps.requireVisibleSession, (req: Request, res: Response) => {
    const sessionParam = str(req.params.id);
    const key = str(req.params.key);
    const record = PROMPT_KEY_RE.test(key) ? answered.get(key) : undefined;
    if (!record || !belongsTo(record, sessionParam)) {
      res.status(404).json({ success: false, error: 'No prompt with that key for this session' });
      return;
    }
    res.json({ success: true, data: { key, state: record.state } });
  });

  router.post('/sessions/:id/prompt', deps.requireVisibleSession, (req: Request, res: Response) => {
    const sessionParam = str(req.params.id);
    const session = deps.getSession(sessionParam);
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
    if (isBarePickerCommand(text)) {
      refuse(res, 400, 'needs_argument', 'This command opens a picker; send it with its choice, like /model sonnet');
      return;
    }

    const digest = requestDigest(session.terminalId ?? '', text, images, mode);
    const first = answered.get(key);
    if (first && first.digest !== digest) {
      refuse(res, 409, 'key_reused', 'This request key was already used for another prompt');
      return;
    }
    // A repeat replays the first answer, unless that send ended without typing a thing.
    if (first && !first.retryable) {
      res.status(202).json(first.body);
      return;
    }

    const imagePaths = images.map((id) => deps.resolveImage(id));
    if (imagePaths.some((p) => p === null)) {
      refuse(res, 400, 'image_not_found', 'An image is no longer on the Mac; attach it again');
      return;
    }

    if (session.status === SESSION_STATUS.CONNECTING) {
      refuse(res, 409, 'agent_not_ready', 'The agent is still starting; try again in a moment');
      return;
    }
    const terminalId = session.terminalId ?? null;
    if (!terminalId || session.status === SESSION_STATUS.ENDED || !deps.terminalExists(terminalId)
      || !isAgentProcessName(deps.foregroundProcess(terminalId))) {
      refuse(res, 409, 'AGENT_NOT_RUNNING', 'The agent is not running in this session’s terminal');
      return;
    }
    if (DIALOG_STATUSES.has(session.status)) {
      if (mode === 'now') {
        refuse(res, 409, 'awaiting_answer', 'The agent is waiting for an answer; answer it or interrupt');
        return;
      }
    } else if (!SENDABLE_STATUSES.has(session.status)) {
      refuse(res, 409, 'agent_not_ready', 'The agent can’t take a prompt right now');
      return;
    }

    if (!deps.submitter.hasRoom(terminalId)) {
      refuse(res, 409, 'busy', 'Another prompt is already waiting to be typed here; try again in a moment');
      return;
    }

    // Last, because it takes the baton: a refused request must not.
    const remote = !deps.isLocal(req);
    const clientId = remote ? deps.clientIdOf(req) : '';
    if (remote && (!clientId || !deps.noteControlActivity(session.sessionId, clientId))) {
      const holder = deps.controller(session.sessionId);
      res.status(423).json({
        success: false,
        error: 'This device was not recognised. Reload it and try again.',
        code: 'control_held',
        driver: holder ? { label: holder.label, online: holder.online } : null,
      });
      return;
    }

    const accepted: Accepted = { success: true, data: { accepted: true, key } };
    const sendId = ++sends;
    answered.set(key, { body: accepted, digest, sessionParam, sessionId: session.sessionId, state: 'pending', sendId, retryable: false });
    res.status(202).json(accepted);
    const reachable = remote ? deps.remoteAccess(req) : null;

    log.info('prompt', `Prompt for ${session.sessionId.slice(0, 8)} accepted (${mode}, ${imagePaths.length} image(s)) from ${remote ? `device ${clientId.slice(0, 8)}` : 'this Mac'}`);
    deps.submitter.submit({
      sessionId: session.sessionId,
      terminalId,
      text,
      imagePaths: imagePaths as string[],
      mode,
      ...(reachable ? { mayDrive: (sessionId: string) => deps.canControl(sessionId, clientId) && reachable(sessionId) } : {}),
    }).then((result) => settle(key, sendId, result)).catch((err: unknown) => {
      settle(key, sendId, { outcome: 'failed', typed: true });
      log.error('prompt', `Prompt for ${session.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return router;
}
