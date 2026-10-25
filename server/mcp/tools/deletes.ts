// tools/deletes.ts — the four P5 deletes (Ruling P5-12): `snippet_delete`, `history_delete`, `note_delete` and
// `agenda_delete`. Each is filed under its own toolset by that toolset's export line (snippets.ts, history.ts, notes.ts,
// agenda.ts); this file imports none of them, so there is no cycle.
//
// All four are `destructive` and always ask: nothing they delete comes back. `confirm` reads the item first, so one
// that is not there is NOT_FOUND before any card, and the card's detail is the item's own text (the book cuts it to
// 2 000). The card's summary is AASC's words, ids and numbers only: it is written into the activity rows. The
// fingerprint is the item's id and when it last changed (Ruling P5-3), so an item changed after the card runs nothing
// until the person is asked about it as it is now (history_delete adds a digest of the title and summary the card shows). `targetSessionId` is the history row's session (history_delete) and
// the note's session (note_delete): the phone's rule of P5-15 reads it.
//
// Scope:
//   * note_delete takes the session as well as the note (as note_update does, P3-15): the session by `resolveTarget`,
//     note_list's rule, and the note must be in that session's notes.
//   * history_delete follows history_get's rule (historyScope.ts, Rulings 32 and 36). A session the store still holds as
//     not ended is refused before anything is read: it is closed first (session_close), so its row stops growing.
// Every rule a central must obey is in the description (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SESSION_STATUS } from '../../constants.js';
import type { ConfirmAsk, ToolContext } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, notInScope, plain, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { historyVisible } from './historyScope.js';
import { num, records, str } from './shape.js';

const GONE = 'it cannot be undone';
const ALWAYS_ASKS = 'Always waits for the person to allow it';
const ON_ANY = `${ALWAYS_ASKS} (NEEDS_CONFIRMATION → confirm_wait).`;
const ON_MAC = `${ALWAYS_ASKS} on the Mac (NEEDS_CONFIRMATION → confirm_wait).`;
const ONLY_ASKED = 'Delete only what the person asked you to.';

/** A short, AASC-made digest of a text: what a fingerprint holds of an item that has no time of its own. */
const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** An item's own text for the card: its lines joined; a placeholder when it has none. */
const cardText = (...parts: Array<string | null>): string => {
  const text = parts.filter((p): p is string => p !== null && p.trim() !== '').join('\n');
  return text === '' ? '(no text)' : text;
};

// ---------------------------------------------------------------------------
// snippet_delete
// ---------------------------------------------------------------------------

const SNIPPET_ID = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('The saved prompt’s number, as snippet_list shows it (#3 is 3).');

const noSuchSnippet = (): ToolError => new ToolError('NOT_FOUND', 'No saved prompt has that id.', 'snippet_list shows the saved prompts and their ids.');

async function snippetOf(ctx: ToolContext, id: number): Promise<{ id: number; text: string; label: string }> {
  const body = unwrap<unknown>(await ctx.client.get('/snippets'));
  const held = records(isRecord(body) ? body.snippets : undefined).find((s) => num(s.id) === id);
  if (held === undefined) throw noSuchSnippet();
  return { id, text: str(held.text) ?? '', label: str(held.label) ?? '' };
}

export const snippetDeleteTool = defineTool({
  name: 'snippet_delete',
  toolset: 'snippets',
  title: 'Delete a saved prompt',
  description:
    'Deletes one of the person’s saved prompts: id is the number snippet_list shows after the # (an unknown id is ' +
    `NOT_FOUND). The card shows the prompt’s text; ${GONE}. ${ONLY_ASKED} ${ON_ANY}`,
  risk: 'destructive',
  phase: 5,
  input: { id: SNIPPET_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    const snippet = await snippetOf(ctx, args.id);
    return {
      summary: `delete saved prompt #${snippet.id} from your library (${GONE})`,
      detail: cardText(snippet.text),
      fingerprint: `snippet:${snippet.id}:${snippet.text.length}:${digestOf(`${snippet.label}\n${snippet.text}`)}`,
    };
  },
  async run(args, ctx) {
    unwrap<unknown>(await ctx.client.del(`/snippets/${args.id}`));
    return {
      data: { id: args.id, deleted: true },
      summary: `Saved prompt #${args.id} deleted.`,
      activity: [{ summary: `deleted saved prompt #${args.id}`, detail: { snippetId: args.id } }],
    };
  },
});

// ---------------------------------------------------------------------------
// history_delete
// ---------------------------------------------------------------------------

const noSuchHistory = (): ToolError =>
  new ToolError('NOT_FOUND', 'The history holds no session with that id.', 'history_list shows the kept sessions and their whole ids.');

const stillOpen = (): ToolError =>
  new ToolError('INVALID', 'That session is still open: close it first (session_close).', 'Once it has ended, call history_delete again.');

/** The store's card for this id when it is not ended: a session that is still open. */
function openSession(ctx: ToolContext, id: string) {
  const current = ctx.resolveSessionId(id) ?? id;
  return ctx.sessions().find((s) => s.sessionId === current && s.status !== SESSION_STATUS.ENDED) ?? null;
}

/** Refuses a session still open: NOT_IN_SCOPE when the central may not see it, else INVALID (P5-12). */
function assertNotOpen(ctx: ToolContext, id: string): void {
  const open = openSession(ctx, id);
  if (open === null) return;
  if (!ctx.inScope(open)) throw notInScope('session');
  throw stillOpen();
}

export const historyDeleteTool = defineTool({
  name: 'history_delete',
  toolset: 'history',
  title: 'Delete a past session from the history',
  description:
    'Deletes one ended session from AASC’s history: its row, prompts, answers, tool calls and events, and its notes and ' +
    `their media; ${GONE}. id is the whole id history_list shows. A session that is still open is refused (INVALID): ` +
    'close it first with session_close. A project or room central may delete only rows history_get would show it. ' +
    `${ONLY_ASKED} ${ON_MAC}`,
  risk: 'destructive',
  phase: 5,
  input: { id: z.string().min(1).max(200).describe('A session id, as history_list shows it (the whole id).') },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    assertNotOpen(ctx, args.id);
    const answer = await ctx.client.get(`/db/sessions/${seg(args.id)}`);
    if (answer.status === 404) throw noSuchHistory();
    const body = unwrap<unknown>(answer);
    const detail = isRecord(body) ? body : {};
    const row = isRecord(detail.session) ? detail.session : null;
    if (row === null) throw noSuchHistory();
    if (!historyVisible(ctx)(args.id, row.project_path)) throw notInScope('session');
    const notes = records(detail.notes).length;
    return {
      summary: `delete session ${shortIdOf(args.id)} from the history, with its notes and their media (${GONE})`,
      detail: cardText(str(row.title), str(row.summary)),
      targetSessionId: args.id,
      fingerprint: `history:${digestOf(args.id)}:${num(row.last_activity_at) ?? ''}:${num(row.total_prompts) ?? ''}:${notes}:${digestOf(`${str(row.title) ?? ''}\n${str(row.summary) ?? ''}`)}`,
    };
  },
  async run(args, ctx) {
    assertNotOpen(ctx, args.id);
    unwrap<unknown>(await ctx.client.del(`/db/sessions/${seg(args.id)}`));
    return {
      data: { id: args.id, deleted: true },
      summary: `Session ${plain(shortIdOf(args.id), 20)} deleted from the history, with its notes and their media.`,
      activity: [{ summary: 'deleted a session from the history', targetSessionId: args.id, detail: { deleted: true } }],
    };
  },
});

// ---------------------------------------------------------------------------
// note_delete
// ---------------------------------------------------------------------------

const NOTE_ID = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('The note’s id, as note_list shows it.');

const noSuchNote = (): ToolError =>
  new ToolError('NOT_FOUND', 'That session has no note with that id.', 'note_list shows the session’s notes and their ids.');

export const noteDeleteTool = defineTool({
  name: 'note_delete',
  toolset: 'notes',
  title: 'Delete a session’s note',
  description:
    'Deletes one note of a session. noteId must be a note of that session as note_list shows it; any other is ' +
    `NOT_FOUND. The card shows the note’s text; ${GONE}. ${ONLY_ASKED} ${ON_ANY}`,
  risk: 'destructive',
  phase: 5,
  input: { sessionId: SESSION_REF, noteId: NOTE_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    const s = resolveTarget(ctx, args.sessionId);
    const held = records(unwrap<unknown>(await ctx.client.get(`/db/sessions/${seg(s.sessionId)}/notes`)));
    const note = held.find((n) => num(n.id) === args.noteId);
    if (note === undefined) throw noSuchNote();
    return {
      summary: `delete note ${args.noteId} of session ${refOf(ctx)(s.sessionId)} (${GONE})`,
      detail: cardText(str(note.text)),
      targetSessionId: s.sessionId,
      fingerprint: `note:${args.noteId}:${num(note.updated_at) ?? ''}:${(str(note.text) ?? '').length}`,
    };
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.sessionId);
    const answer = await ctx.client.del(`/db/notes/${args.noteId}`);
    if (answer.status === 404) throw noSuchNote();
    unwrap<unknown>(answer);
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), noteId: args.noteId, deleted: true },
      summary: `Note ${args.noteId} of session ${plain(shortIdOf(s.sessionId), 20)} deleted.`,
      activity: [{ summary: `deleted note ${args.noteId}`, targetSessionId: s.sessionId, detail: { noteId: args.noteId } }],
    };
  },
});

// ---------------------------------------------------------------------------
// agenda_delete
// ---------------------------------------------------------------------------

const TASK_ID = z.string().min(1).max(100).describe('The task’s id, as agenda_list shows it.');

const noSuchTask = (): ToolError => new ToolError('NOT_FOUND', 'There is no agenda task with that id.', 'agenda_list shows the tasks and their ids.');

export const agendaDeleteTool = defineTool({
  name: 'agenda_delete',
  toolset: 'agenda',
  title: 'Delete an agenda task',
  description:
    'Deletes one task from the person’s agenda: id as agenda_list shows it (an unknown id is NOT_FOUND). To mark a ' +
    `task done instead, use agenda_toggle. The card shows the task’s title and description; ${GONE}. ${ONLY_ASKED} ${ON_MAC}`,
  risk: 'destructive',
  phase: 5,
  input: { id: TASK_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    const tasks = records(unwrap<unknown>(await ctx.client.get('/agenda')));
    const task = tasks.find((t) => str(t.id) === args.id);
    if (task === undefined) throw noSuchTask();
    return {
      summary: `delete agenda task ${plain(args.id, 8)} (${GONE})`,
      detail: cardText(str(task.title), str(task.description)),
      fingerprint: `agenda:${digestOf(args.id)}:${str(task.updatedAt) ?? (str(task.title) ?? '').length}`,
    };
  },
  async run(args, ctx) {
    const answer = await ctx.client.del(`/agenda/${seg(args.id)}`);
    if (answer.status === 404) throw noSuchTask();
    unwrap<unknown>(answer);
    return {
      data: { id: args.id, deleted: true },
      summary: `Agenda task ${plain(args.id, 80)} deleted.`,
      activity: [{ summary: `deleted agenda task ${plain(args.id, 80)}`, detail: { taskId: args.id } }],
    };
  },
});
