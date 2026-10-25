// tools/agenda.ts — the agenda toolset, P1: the person's own task list (`GET /api/agenda`). Read only here; adding,
// changing and toggling tasks (P3) are in agendaWrite.ts, and deleting one (P5, `agenda_delete`) is in deletes.ts.
//
// A task's title and description are what the person wrote: fenced as untrusted in `data` (each on its own, from a
// source that names the task), and the rows in the text sit in one block. Ids, priorities, tags, dates and the
// done flag stay plain. The list belongs to the Mac, not to a session: every central that has the toolset may
// read it. The route filters on `completed` only; the rest is filtered here.

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { defineTool, fence, nonEmptyString, oneLine, plural, unwrap } from './define.js';
import { agendaWriteTools } from './agendaWrite.js';
import { agendaDeleteTool } from './deletes.js';
import { CURSOR_INPUT, fenced, isoOrNull, limitInput, pageOf, pageWords, records, str, strings } from './shape.js';

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;
const TITLE_MAX = 500;
const DESCRIPTION_MAX = 2_000;
const ROW_TEXT = 120;

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

interface Task {
  id: string;
  title: string;
  description: string;
  priority: string;
  tags: string[];
  dueDate: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function taskOf(raw: Record<string, unknown>): Task | null {
  const id = str(raw.id);
  if (id === null || id === '') return null;
  return {
    id,
    title: str(raw.title) ?? '',
    description: str(raw.description) ?? '',
    priority: str(raw.priority) ?? 'medium',
    tags: strings(raw.tags),
    // Plain in `data`, so only a date gets through (the type says YYYY-MM-DD); any other text in the field is dropped.
    dueDate: isoOrNull(raw.dueDate),
    completed: raw.completed === true,
    completedAt: nonEmptyString(raw.completedAt),
    createdAt: str(raw.createdAt) ?? '',
    updatedAt: str(raw.updatedAt) ?? '',
  };
}

function matches(t: Task, args: { priority?: string; tag?: string; query?: string }): boolean {
  if (args.priority !== undefined && t.priority !== args.priority) return false;
  if (args.tag !== undefined && !t.tags.some((tag) => tag.toLowerCase() === args.tag?.toLowerCase())) return false;
  if (args.query === undefined) return true;
  const needle = args.query.toLowerCase();
  return [t.title, t.description, ...t.tags].some((s) => s.toLowerCase().includes(needle));
}

const agendaList = defineTool({
  name: 'agenda_list',
  toolset: 'agenda',
  title: 'List agenda tasks',
  description:
    'Lists the person’s agenda tasks: id, title, description (both fenced as untrusted data), priority, tags, due ' +
    'date, whether it is done and when. Filter by done or not, priority, a tag, or a text in the title, ' +
    'description or tags. 100 to a page, up to 500; pass nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: {
    completed: z.boolean().optional().describe('Only done tasks (true) or only open ones (false).'),
    priority: z.enum(PRIORITIES).optional().describe('Only tasks of this priority.'),
    tag: z.string().trim().min(1).max(100).optional().describe('Only tasks with this tag (any case).'),
    query: z.string().trim().min(1).max(200).optional().describe('Only tasks with this text in the title, description or tags (any case).'),
    cursor: CURSOR_INPUT,
    limit: limitInput(PAGE_MAX, PAGE_DEFAULT),
  },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get('/agenda', args.completed === undefined ? undefined : { completed: args.completed }));
    const all = records(body).flatMap((raw) => {
      const task = taskOf(raw);
      return task === null ? [] : [task];
    });
    const found = all.filter((t) => matches(t, args));
    const page = pageOf(found.length, args.cursor, args.limit ?? PAGE_DEFAULT);
    const shown = found.slice(page.start, page.end);
    const data = {
      count: found.length,
      total: all.length,
      shown: shown.length,
      start: page.start,
      nextCursor: page.next,
      tasks: shown.map((t) => {
        const description = t.description === '' ? null : fenced(`agenda:${t.id}`, 'agenda-description', t.description, DESCRIPTION_MAX);
        return {
          id: t.id,
          title: fenced(`agenda:${t.id}`, 'agenda-title', t.title, TITLE_MAX).value,
          description: description?.value ?? null,
          descriptionTruncated: description?.truncated ?? false,
          priority: t.priority,
          tags: t.tags,
          dueDate: t.dueDate,
          completed: t.completed,
          completedAt: t.completedAt,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      }),
    };
    if (all.length === 0) return { data, summary: 'No agenda tasks.' };
    if (shown.length === 0) return { data, summary: found.length === 0 ? 'No agenda task matches.' : 'The cursor is past the end of the list.' };
    const { of, range, more } = pageWords(page, found.length, all.length);
    const rows = shown.map((t) =>
      [
        `${t.completed ? '[x]' : '[ ]'} ${t.id}`,
        t.priority,
        t.dueDate === null ? null : `due ${t.dueDate}`,
        JSON.stringify(oneLine(t.title, ROW_TEXT)),
        t.tags.length > 0 ? t.tags.map((tag) => `#${tag}`).join(' ') : null,
      ]
        .filter((p): p is string => p !== null)
        .join(' · '),
    );
    return {
      data,
      summary: `${plural(found.length, 'agenda task')}${of}${range}.${more}\n${fence('aasc', 'agenda', rows.join('\n'))}`,
    };
  },
});

export const agendaTools: readonly ToolDef[] = [agendaList, ...agendaWriteTools, agendaDeleteTool];
