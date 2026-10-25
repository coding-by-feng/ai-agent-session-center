// tools/agendaWrite.ts — the agenda toolset's P3 writes: `agenda_add`, `agenda_update` and `agenda_toggle`. Filed under
// `agenda` by agenda.ts's export line.
//
// The agenda is the person's own task list (`/api/agenda`). A title and tags a central writes are read back by other
// centrals through agenda_list, which fences them as untrusted; the answers here carry ids, priorities, dates and the
// done flag only, never the text. The limits are the routes' schemas (apiRouter.ts `agendaCreateSchema` and
// `agendaUpdateSchema`). Every rule a central must obey is in the description (Ruling 65), and what it acts on is in
// `data` (Ruling 66).

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, nonEmptyString, plain, seg, unwrap } from './define.js';
import { isoOrNull, str } from './shape.js';

const TITLE_MAX = 500;
const TAGS_MAX = 20;
const TAG_MAX = 100;
const ID_MAX = 100;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const RULES = 'The person reads the agenda: add or change only what they asked for. What you write is later read by other sessions as untrusted data.';

/** A real calendar day, `YYYY-MM-DD`: `2026-02-30` is not one. */
function isCalendarDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const day = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(text);
}

const DUE_DATE = z.string().refine(isCalendarDay, { message: 'a date as YYYY-MM-DD' });
const TITLE = z.string().trim().min(1).max(TITLE_MAX);
const PRIORITY = z.enum(PRIORITIES);
const TAGS = z.array(z.string().trim().min(1).max(TAG_MAX)).max(TAGS_MAX);
const TASK_ID = z.string().min(1).max(ID_MAX).describe('The task’s id, as agenda_list shows it.');

const noSuchTask = (): ToolError => new ToolError('NOT_FOUND', 'There is no agenda task with that id.', 'agenda_list shows the tasks and their ids.');

/** What a task answer holds that is safe to give back plain: ids, priority, date, flags. */
function taskFacts(body: unknown, fallbackId: string): { id: string; priority: string; dueDate: string | null; completed: boolean } {
  const task = isRecord(body) ? body : {};
  return {
    id: nonEmptyString(task.id) ?? fallbackId,
    priority: str(task.priority) ?? 'medium',
    dueDate: isoOrNull(task.dueDate),
    completed: task.completed === true,
  };
}

const agendaAdd = defineTool({
  name: 'agenda_add',
  toolset: 'agenda',
  title: 'Add an agenda task',
  description:
    `Adds a task to the person’s agenda: title (up to ${TITLE_MAX} characters), and optionally priority (low, medium ` +
    `which is the default, high or urgent), tags (up to ${TAGS_MAX}, each up to ${TAG_MAX} characters) and dueDate as ` +
    `YYYY-MM-DD. Answers the new task’s id. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: {
    title: TITLE.describe(`The task, up to ${TITLE_MAX} characters.`),
    priority: PRIORITY.optional().describe('low, medium (the default), high or urgent.'),
    tags: TAGS.optional().describe(`Up to ${TAGS_MAX} tags.`),
    dueDate: DUE_DATE.optional().describe('The day it is due, as YYYY-MM-DD.'),
  },
  async run(args, ctx) {
    const body = {
      title: args.title.trim(),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
      ...(args.dueDate === undefined ? {} : { dueDate: args.dueDate }),
    };
    const facts = taskFacts(unwrap<unknown>(await ctx.client.post('/agenda', body)), '');
    if (facts.id === '') throw new ToolError('UPSTREAM', 'AASC added the task but did not say which.', 'agenda_list shows the tasks.');
    return {
      data: facts,
      summary: `Agenda task ${plain(facts.id, 80)} added (${facts.priority}${facts.dueDate === null ? '' : `, due ${facts.dueDate}`}).`,
      activity: [{ summary: `added agenda task ${plain(facts.id, 80)}`, detail: { taskId: facts.id } }],
    };
  },
});

const agendaUpdate = defineTool({
  name: 'agenda_update',
  toolset: 'agenda',
  title: 'Change an agenda task',
  description:
    'Changes a task of the person’s agenda: id as agenda_list shows it, and at least one of title, priority, tags or ' +
    'dueDate (null clears the date). tags replaces the whole list (an empty list clears it); anything left out stays as ' +
    `it is. Use agenda_toggle to mark a task done or open. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: {
    id: TASK_ID,
    title: TITLE.optional().describe(`The new title, up to ${TITLE_MAX} characters.`),
    priority: PRIORITY.optional().describe('low, medium, high or urgent.'),
    tags: TAGS.optional().describe(`The tags the task should have, replacing its current ones (up to ${TAGS_MAX}).`),
    dueDate: DUE_DATE.nullable().optional().describe('The new due day as YYYY-MM-DD, or null to clear it.'),
  },
  async run(args, ctx) {
    const body = {
      ...(args.title === undefined ? {} : { title: args.title.trim() }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
      ...(args.dueDate === undefined ? {} : { dueDate: args.dueDate }),
    };
    if (Object.keys(body).length === 0) {
      throw new ToolError('INVALID', 'Give at least one of title, priority, tags or dueDate to change.', 'agenda_toggle marks a task done or open.');
    }
    const answer = await ctx.client.put(`/agenda/${seg(args.id)}`, body);
    if (answer.status === 404) throw noSuchTask();
    const facts = taskFacts(unwrap<unknown>(answer), args.id);
    return {
      data: facts,
      summary: `Agenda task ${plain(facts.id, 80)} changed (${Object.keys(body).join(', ')}).`,
      activity: [{ summary: `changed agenda task ${plain(facts.id, 80)}`, detail: { taskId: facts.id } }],
    };
  },
});

const agendaToggle = defineTool({
  name: 'agenda_toggle',
  toolset: 'agenda',
  title: 'Mark an agenda task done or open',
  description:
    'Flips a task of the person’s agenda between open and done: a done task becomes open, an open one done. id as ' +
    'agenda_list shows it. The answer says which it is now and when it was completed, so call it again only to ' +
    `flip it back. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: { id: TASK_ID },
  async run(args, ctx) {
    const answer = await ctx.client.patch(`/agenda/${seg(args.id)}/toggle`);
    if (answer.status === 404) throw noSuchTask();
    const body = unwrap<unknown>(answer);
    const facts = taskFacts(body, args.id);
    const completedAt = isRecord(body) ? nonEmptyString(body.completedAt) : null;
    return {
      data: { id: facts.id, completed: facts.completed, completedAt },
      summary: `Agenda task ${plain(facts.id, 80)} is ${facts.completed ? 'done' : 'open again'} now.`,
      activity: [{ summary: `marked agenda task ${plain(facts.id, 80)} ${facts.completed ? 'done' : 'open'}`, detail: { taskId: facts.id } }],
    };
  },
});

export const agendaWriteTools: readonly ToolDef[] = [agendaAdd, agendaUpdate, agendaToggle];
