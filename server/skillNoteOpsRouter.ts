// skillNoteOpsRouter.ts — a central's change to something only the AASC window holds, for that window to carry out:
// a skill note (favourite, tags, abbreviation; P3, Ruling P3-13) and the keep-awake setting (A-I1).
//
//   POST /skill-notes/ops               { agent, name, set } → the workspace writer's window, as `skill_note_op`
//   POST /skill-notes/ops/:opId/result  the window's answer { ok, error? }, from that window only
//   POST /keep-awake/ops                { on } → the workspace writer's window, as `keep_awake_op`
//   POST /keep-awake/ops/:opId/result   the window's answer { ok, error? }, from that window only
//
// Skill notes live in the window (`skillNotesStore`, synced to the person's AASC Cloud account), and keep-awake is the
// window's own setting (it pushes it to the server on load and on change, so a server-only change is undone by the next
// push). So the server cannot make either change: like a room change (roomsRouter.ts) the op goes to the one device
// that applies them, the workspace writer, and only when that device is on this Mac (skillNoteOpsWiring.ts). Unlike a
// room change, the caller is waiting for the outcome, so the route holds the request until the window answers:
//
//   200 { ok, applied: true }              the window applied it
//   400 { ok: false, error }               the window refused it (its own code), or the op is not well formed
//   202 { ok, applied: false, pending }    no answer within the wait: it may still be applied
//   409 { ok: false, error: 'no-writer' }  no window on this Mac could apply it
//   404                                    a remote caller: only this Mac makes these changes
//
// The opId is made here and goes only to the writer's socket; no answer to the caller carries it. A result is taken
// once, on its own kind's route, from a local caller whose client id is the writer the op was sent to (403 otherwise;
// 404 for an op nobody waits for). What the window says is cut to one short line.

import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SKILL_NOTE_OP, type SkillNoteOpMessage, type SkillNoteOpResult } from '../src/types/skillNoteOps.js';
import { KEEP_AWAKE_OP, type KeepAwakeOpMessage } from '../src/types/websocket.js';

/** How long a caller waits for the window's answer before it is told "pending". */
export const SKILL_NOTE_OP_WAIT_MS = 5_000;
/** Ops waiting for a window at once: more is a caller that outruns the window. */
export const SKILL_NOTE_OPS_PENDING_MAX = 50;
const RESULT_ERROR_MAX = 200;

const AGENT = z.enum(['claude', 'codex', 'shared']);
const NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/);
// 24 is the window's MAX_TAG_CHARS (src/lib/skillNotes.ts).
const TAG = z.string().regex(/^[a-z0-9_-]{1,24}$/);
const ABBR = z.string().regex(/^[a-z0-9_-]{1,20}$/);

const changeSchema = z
  .strictObject({
    fav: z.boolean().optional(),
    tags: z.array(TAG).max(10).optional(),
    abbr: ABBR.nullable().optional(),
  })
  .refine((c) => c.fav !== undefined || c.tags !== undefined || c.abbr !== undefined, { message: 'nothing to change' });

const opSchema = z.strictObject({ agent: AGENT, name: NAME, set: changeSchema });
const keepAwakeSchema = z.strictObject({ on: z.boolean() });
const resultSchema = z.object({ ok: z.boolean(), error: z.string().max(2_000).optional() });

/** What the writer's window is sent. */
export type WindowOpMessage = SkillNoteOpMessage | KeepAwakeOpMessage;
type OpKind = WindowOpMessage['type'];

export interface SkillNoteOpsDeps {
  /** Is the request from this machine? Must be `isLocalRequest`, like every other visibility gate. */
  isLocal: (req: Request) => boolean;
  /** The caller's device id ('' when anonymous or refused), as `clientIdFromRequest` gives it. */
  clientId: (req: Request) => string;
  /** The device on this Mac that applies these changes, or null when none is connected that could. */
  writer: () => Promise<string | null> | string | null;
  /** Deliver a message to every open socket of one device; how many got it. */
  sendToClient: (clientId: string, msg: WindowOpMessage) => Promise<number> | number;
  newOpId?: () => string;
  /** The wait for the window's answer, in ms; 5 s by default. */
  waitMs?: number;
}

interface Pending {
  kind: OpKind;
  writer: string;
  resolve: (result: SkillNoteOpResult | null) => void;
  timer: NodeJS.Timeout;
}

/** The fields that failed, never the values: a central's argument is not repeated back. */
function invalidWords(error: z.ZodError, what: string): string {
  const where = [...new Set(error.issues.map((i) => i.path.map(String).join('.') || 'body'))].slice(0, 5).join(', ');
  return `Invalid ${what} (${where})`;
}

/** What the window said as one short line (control characters become spaces). */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const folded = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return folded.slice(0, RESULT_ERROR_MAX);
}

export function createSkillNoteOpsRouter(deps: SkillNoteOpsDeps): Router {
  const router = Router();
  const newOpId = deps.newOpId ?? randomUUID;
  const waitMs = deps.waitMs ?? SKILL_NOTE_OP_WAIT_MS;
  const pending = new Map<string, Pending>();

  /** Holds the caller for the window's answer: the result, or null when the wait ran out. */
  function waitFor(opId: string, kind: OpKind, writer: string): Promise<SkillNoteOpResult | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(opId);
        resolve(null);
      }, waitMs);
      timer.unref();
      pending.set(opId, { kind, writer, resolve, timer });
    });
  }

  function forget(opId: string): void {
    const held = pending.get(opId);
    if (held === undefined) return;
    clearTimeout(held.timer);
    pending.delete(opId);
    held.resolve(null);
  }

  /** Sends one op to the writer and answers the caller with the window's outcome. */
  async function carryOut(res: Response, kind: OpKind, build: (opId: string) => WindowOpMessage): Promise<void> {
    if (pending.size >= SKILL_NOTE_OPS_PENDING_MAX) {
      res.status(429).json({ ok: false, error: 'too-many-pending' });
      return;
    }
    const writer = await deps.writer();
    if (!writer) {
      res.status(409).json({ ok: false, error: 'no-writer' });
      return;
    }
    const opId = newOpId();
    // Waiting starts before the message is sent: a window may answer before sendToClient returns.
    const answered = waitFor(opId, kind, writer);
    let delivered = 0;
    try {
      delivered = await deps.sendToClient(writer, build(opId));
    } catch {
      delivered = 0;
    }
    if (!delivered) {
      forget(opId);
      await answered;
      res.status(409).json({ ok: false, error: 'no-writer' });
      return;
    }
    const result = await answered;
    if (result === null) {
      res.status(202).json({ ok: true, applied: false, pending: true });
      return;
    }
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error ?? 'refused' });
      return;
    }
    res.json({ ok: true, applied: true });
  }

  /** The route that takes the window's answer to one kind of op. */
  function takeResult(kind: OpKind) {
    return (req: Request, res: Response): void => {
      const opId = typeof req.params.opId === 'string' ? req.params.opId : '';
      const held = pending.get(opId);
      if (held === undefined || held.kind !== kind) {
        res.status(404).json({ ok: false, error: 'Unknown op' });
        return;
      }
      // Only the window the op was sent to answers it, from this machine.
      const clientId = deps.clientId(req);
      if (!deps.isLocal(req) || clientId === '' || clientId !== held.writer) {
        res.status(403).json({ ok: false, error: 'Not the window this op was sent to' });
        return;
      }
      const result = resultSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ ok: false, error: 'A result is { ok, error? }' });
        return;
      }
      clearTimeout(held.timer);
      pending.delete(opId);
      held.resolve(result.data.ok ? { ok: true } : { ok: false, error: oneLine(result.data.error ?? '') || 'refused' });
      res.json({ ok: true });
    };
  }

  router.post('/skill-notes/ops', async (req: Request, res: Response) => {
    // Only this Mac changes skill notes: a remote device gets what an unknown route gets.
    if (!deps.isLocal(req)) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const op = opSchema.safeParse(req.body);
    if (!op.success) {
      res.status(400).json({ ok: false, error: invalidWords(op.error, 'skill note change') });
      return;
    }
    const key = `${op.data.agent}:${op.data.name}`;
    await carryOut(res, SKILL_NOTE_OP, (opId) => ({ type: SKILL_NOTE_OP, opId, key, set: op.data.set }));
  });

  router.post('/keep-awake/ops', async (req: Request, res: Response) => {
    // Only this Mac decides how it sleeps (POST /config/keep-awake is local-only too).
    if (!deps.isLocal(req)) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const op = keepAwakeSchema.safeParse(req.body);
    if (!op.success) {
      res.status(400).json({ ok: false, error: invalidWords(op.error, 'keep-awake change') });
      return;
    }
    await carryOut(res, KEEP_AWAKE_OP, (opId) => ({ type: KEEP_AWAKE_OP, opId, on: op.data.on }));
  });

  router.post('/skill-notes/ops/:opId/result', takeResult(SKILL_NOTE_OP));
  router.post('/keep-awake/ops/:opId/result', takeResult(KEEP_AWAKE_OP));

  return router;
}
