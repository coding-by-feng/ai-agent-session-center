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
//     hook (trusting the folder): 409 agent_not_ready; so may any card whose terminal AASC
//     has not heard a hook from (a timeout-idle CLI, a shell card the person started a CLI
//     in), so a central's prompt, `interrupt` too, is 409 not_started unless the terminal
//     was heard, whatever the card's command (Rulings P4-35, P4-41, P4-50);
//   - `now` never types into an open dialog (approval or a question), where the text
//     could pick an option: 409 awaiting_answer (`interrupt` declines it first);
//   - one prompt may wait behind the one being typed into a terminal, no more: 409 busy;
//   - a picker-opening slash command needs its argument (`/model sonnet`): 400 needs_argument;
//   - a remote caller must be able to drive the session (the control baton): 423
//     control_held, with who holds it. The Mac itself is not arbitrated, as for writes.
//     While the send runs, a remote caller's prompt stops as soon as it may no longer
//     drive the session, the session stops being shared, or its sign-in ends.
//   - a central's prompt (an `mcp:` caller on this Mac, Ruling 51) stops the same way, as
//     soon as the session goes hands-off, a person drives it (HUMAN_ACTIVE_MS), or the
//     person stops it with Esc; the key's outcome then says `stoppedBy`. The cancel stamp
//     its own `interrupt` Esc causes is not the person's (server/mcp/escHold.ts).
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
import { centralEscBook, isEscHeld } from './mcp/escHold.js';
import { terminalHeard } from './heardTerminals.js';
import { NOT_STARTED_ERROR, NOT_STARTED_HINT } from './mcp/ledgerReroute.js';
import { HUMAN_ACTIVE_MS, MCP_CLIENT_PREFIX } from './mcp/policy.js';

/** What the route reads of a session. */
export interface PromptRouterSession {
  sessionId: string;
  terminalId?: string | null;
  status: string;
  /** The person marked it hands-off: a central's prompt stops. */
  handsOff?: boolean;
  /** The person stopped its turn with Esc (sessionStore): a central's prompt stops until they prompt it again. */
  userCancelledAt?: number | null;
  /** `false`: the connecting timeout turned it idle before its terminal sent a hook; a central's prompt is refused. */
  startHeard?: boolean;
}

/** Why a central's send was stopped by its rails: the session went hands-off, or a person took it. */
export type PromptStopReason = 'hands-off' | 'person';

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
  /** Who holds the session's baton, for a refusal to name (and, for a central's send, how recently they drove it). */
  controller(sessionId: string): { label: string; online: boolean; clientId?: string; lastActivityAt?: number } | null;
  /** The path of an uploaded queue image, by id, or null when it is gone. */
  resolveImage(id: string): string | null;
  submitter: Pick<PromptSubmitter, 'submit' | 'hasRoom'>;
  /** When a central last pressed Esc in the session or its terminal; the server's book of central Escs by default. */
  centralEscAt?(sessionId: string, terminalId: string | null): number | null;
  /** A central is about to press Esc there (its `interrupt` prompt); the server's book by default. */
  noteCentralEsc?(sessionId: string, terminalId: string | null): void;
  /** Has AASC heard a hook from the CLI in this terminal (Ruling P4-50)? The server's heard set by default. */
  terminalHeard?(terminalId: string): boolean;
  now?(): number;
}

/** Prompt images per send, as the phone's composer allows. */
export const MAX_PROMPT_IMAGES = 4;
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
  /** A central's send its rails stopped, and why. */
  stoppedBy: PromptStopReason | null;
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
  const now = deps.now ?? Date.now;
  const centralEscAt = deps.centralEscAt ?? ((sessionId, terminalId) => centralEscBook.at(sessionId, terminalId));
  const noteCentralEsc = deps.noteCentralEsc ?? ((sessionId, terminalId) => centralEscBook.note(sessionId, terminalId));
  const heard = deps.terminalHeard ?? terminalHeard;
  // The outcome lands seconds later; keep it on the key's record (a new object: the
  // cache holds immutable values) so the phone can ask what became of its prompt.
  const settle = (key: string, sendId: number, result: PromptResult, stoppedBy: PromptStopReason | null): void => {
    const record = answered.get(key);
    if (!record || record.sendId !== sendId) return;
    const retryable = !result.typed && (result.outcome === 'stopped' || result.outcome === 'failed');
    answered.set(key, { ...record, state: result.outcome, retryable, stoppedBy: result.outcome === 'stopped' ? stoppedBy : null });
  };
  /** Did a person (not a central) drive the session less than HUMAN_ACTIVE_MS ago? */
  const personActive = (sessionId: string): boolean => {
    const holder = deps.controller(sessionId);
    return typeof holder?.clientId === 'string' && !holder.clientId.startsWith(MCP_CLIENT_PREFIX)
      && typeof holder.lastActivityAt === 'number' && now() - holder.lastActivityAt < HUMAN_ACTIVE_MS;
  };
  /**
   * A central's rails, checked before every keystroke of its send: false once the session is hands-off, a person
   * drove it, or the person stopped it with Esc. `stoppedBy` says which stopped it.
   */
  const centralRails = (): { mayDrive: (sessionId: string) => boolean; stoppedBy: () => PromptStopReason | null } => {
    let reason: PromptStopReason | null = null;
    const mayDrive = (sessionId: string): boolean => {
      const s = deps.getSession(sessionId);
      if (s?.handsOff === true) reason = 'hands-off';
      else if (personActive(sessionId)) reason = 'person';
      else if (s && isEscHeld(s.userCancelledAt, centralEscAt(s.sessionId, s.terminalId ?? null))) reason = 'person';
      else return true;
      return false;
    };
    return { mayDrive, stoppedBy: () => reason };
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
    const stopped = record.state === 'stopped' && record.stoppedBy !== null ? { stoppedBy: record.stoppedBy } : {};
    res.json({ success: true, data: { key, state: record.state, ...stopped } });
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
    // Its CLI may be showing a question that fires no hook (its folder-trust prompt), where a central's text would
    // answer it. Every mode: an interrupt's Esc would answer it too. Positive (Ruling P4-50): the terminal must have
    // been heard, whatever the card's command. A person sees the terminal and is not refused.
    const unheard = session.startHeard === false || (!!session.terminalId && !heard(session.terminalId));
    if (unheard && deps.clientIdOf(req).startsWith(MCP_CLIENT_PREFIX)) {
      res.status(409).json({ success: false, error: `${NOT_STARTED_ERROR} ${NOT_STARTED_HINT}`, code: 'not_started', hint: NOT_STARTED_HINT });
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
    answered.set(key, {
      body: accepted, digest, sessionParam, sessionId: session.sessionId, state: 'pending', sendId, retryable: false, stoppedBy: null,
    });
    res.status(202).json(accepted);
    const reachable = remote ? deps.remoteAccess(req) : null;
    const rails = !remote && deps.clientIdOf(req).startsWith(MCP_CLIENT_PREFIX) ? centralRails() : null;
    // Its own Esc's cancel stamp lands after this: it is the central's, not the person's.
    if (rails && mode === 'interrupt') noteCentralEsc(session.sessionId, terminalId);

    log.info('prompt', `Prompt for ${session.sessionId.slice(0, 8)} accepted (${mode}, ${imagePaths.length} image(s)) from ${remote ? `device ${clientId.slice(0, 8)}` : 'this Mac'}`);
    deps.submitter.submit({
      sessionId: session.sessionId,
      terminalId,
      text,
      imagePaths: imagePaths as string[],
      mode,
      ...(reachable ? { mayDrive: (sessionId: string) => deps.canControl(sessionId, clientId) && reachable(sessionId) } : {}),
      ...(rails ? { mayDrive: rails.mayDrive } : {}),
    }).then((result) => settle(key, sendId, result, rails?.stoppedBy() ?? null)).catch((err: unknown) => {
      settle(key, sendId, { outcome: 'failed', typed: true }, null);
      log.error('prompt', `Prompt for ${session.sessionId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  return router;
}
