// phoneAnswerable.ts — may a paired phone answer this card (Rulings P5-15, P5-20, P5-25, P5-36)? One pure rule, read
// by the phone's routes and feed (phoneConfirmRoutes.ts), the approval push (confirmPush.ts), and the confirmation gate
// (runTool.ts), which opens a card with the Mac window closed only when a phone could answer it, and says where.
//
// A phone answers only what it could already do itself (PHONE_ANSWERABLE: each tool, and the phone-profile route it
// mirrors), and only about sessions shared with it: the central's card is shared (`remoteVisible`), and so is the
// card's target when it has one (a note's session is its target). Mac-only: `session_set_shared`,
// `resource_uninstall`, `history_delete`, `agenda_delete` and everything else.
//
// Nothing here reads the store, the book or the clock: the caller hands in what it sees now.

import type { Session } from '../../src/types/session.js';
import type { PendingConfirm } from './confirm.js';

export interface PhoneAnswerable {
  /** The phone-profile route (server/mobile/phoneProfile.ts) the tool's effect mirrors. */
  readonly mirrors: string;
  /** Its card must name a target session: a card without one is not the phone's. */
  readonly target: boolean;
}

/** The tools a phone may answer, each with the route a phone could already call to do the same (P5-15). */
export const PHONE_ANSWERABLE: ReadonlyMap<string, PhoneAnswerable> = new Map<string, PhoneAnswerable>([
  ['session_interrupt', { mirrors: 'POST /terminals/:id/write (type): an Esc', target: true }],
  ['session_restart', { mirrors: 'POST /sessions/:id/restart-terminal', target: true }],
  ['session_kill', { mirrors: 'POST /sessions/:id/kill', target: true }],
  ['session_close', { mirrors: 'DELETE /sessions/:id', target: true }],
  ['queue_clear', { mirrors: 'PUT /sessions/:id/queue', target: true }],
  ['note_delete', { mirrors: 'PUT|DELETE /db/notes/:id', target: true }],
  ['snippet_delete', { mirrors: 'PATCH|DELETE /snippets/:id', target: false }],
  ['snippet_create', { mirrors: 'GET|POST /snippets', target: false }],
  ['snippet_rename', { mirrors: 'GET|POST /snippets', target: false }],
]);

/** What the rule reads, as the caller sees it now. */
export interface PhoneAnswerDeps {
  getSession(id: string): Session | null | undefined;
  /** The card the central runs in, or null. */
  centralCard(centralId: string): Session | null;
  /** Is this session shared with remote devices right now? Unknown is not. */
  isShared(sessionId: string): boolean;
}

/** What the rule judges of a card: an open record, or the card the gate is about to open. */
export type PhoneCard = Pick<PendingConfirm, 'tool' | 'centralId' | 'targetSessionId'>;

/** The tool, the central's card and the target allow a phone, whatever the record's state. */
export function shareable(r: PhoneCard, deps: PhoneAnswerDeps): boolean {
  const rule = PHONE_ANSWERABLE.get(r.tool);
  if (rule === undefined) return false;
  const card = deps.centralCard(r.centralId);
  if (card === null || !deps.isShared(card.sessionId)) return false;
  if (r.targetSessionId === null) return !rule.target;
  return deps.getSession(r.targetSessionId) != null && deps.isShared(r.targetSessionId);
}

/** May a paired phone answer this card now: pending, a phone-answerable tool, about sessions shared with it? */
export function phoneMayAnswer(r: PhoneCard & Pick<PendingConfirm, 'state'>, deps: PhoneAnswerDeps): boolean {
  return r.state === 'pending' && shareable(r, deps);
}
