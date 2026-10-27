// tools/history.ts — the history toolset, P1: the sessions AASC has kept (live and ended), one of them in detail,
// and the project folders they ran in. (Searching text is in historySearch.ts; deleting a session, `history_delete`, is
// P5 and in deletes.ts.) Read only here.
//
// History is a second store, and what a central may read of it is judged by the folder a row is filed under for a
// session that has ended (it may be gone from memory), and by session scope for one that is still live: see
// historyScope.ts for the rules (Rulings 32 and 36), and historyRead.ts for how a page of it is read for a central that
// sees only part of it. What a session wrote (its title, summary, remark, prompts, answers) is fenced as untrusted in
// `data`, and the rows in the text sit in one block; ids, folders, statuses, counts and times stay plain.

import { z } from 'zod';
import type { SessionStatus } from '../../../src/types/session.js';
import { SESSION_STATUS } from '../../constants.js';
import type { ToolDef } from '../registry.js';
import { defineTool, fence, isRecord, notInScope, oneLine, plain, plural, seg, unwrap, writtenFolder } from './define.js';
import { historyDeleteTool } from './deletes.js';
import { emptyWords, historyPage, moreWords, type Row } from './historyRead.js';
import { DATE_INPUT, dateMs, historyAllows, historyVisible, isHarnessText, readHistory } from './historyScope.js';
import { historySearchTools } from './historySearch.js';
import { CURSOR_INPUT, fenced, isoTime, limitInput, num, pageOf, pageWords, queryOf, records, str, strings, whole } from './shape.js';

const STATUSES = Object.values(SESSION_STATUS) as [SessionStatus, ...SessionStatus[]];

const LIST_PAGE_DEFAULT = 50;
const LIST_PAGE_MAX = 100;
const NAMES_DEFAULT = 100;
const NAMES_MAX = 500;
const TITLE_MAX = 300;
const SUMMARY_MAX = 1_000;
const BODY_MAX = 1_000;
const ROW_TEXT = 160;
const PROMPTS_SHOWN = 20;
const RESPONSES_SHOWN = 10;
const NOTES_SHOWN = 10;
const TOOLS_SHOWN = 15;

// ---------------------------------------------------------------------------
// A session row
// ---------------------------------------------------------------------------

export interface HistoryRow {
  id: string;
  /** Fenced as untrusted. */
  title: string;
  summary: string | null;
  remark: string | null;
  project: { path: string; name: string };
  status: string;
  source: string;
  model: string;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  prompts: number;
  toolCalls: number;
  archived: boolean;
}

/** One `sessions` row as the database answers it; null for one with no id. */
export function historyRowOf(raw: Record<string, unknown>): HistoryRow | null {
  const id = str(raw.id);
  if (id === null || id === '') return null;
  const source = `session:${id}`;
  const summary = str(raw.summary) ?? '';
  const remark = str(raw.remark) ?? '';
  return {
    id,
    title: fenced(source, 'title', str(raw.title) ?? '', TITLE_MAX).value,
    summary: summary === '' ? null : fenced(source, 'summary', summary, SUMMARY_MAX).value,
    remark: remark === '' ? null : fenced(source, 'remark', remark, SUMMARY_MAX).value,
    project: { path: str(raw.project_path) ?? '', name: str(raw.project_name) ?? '' },
    status: str(raw.status) ?? '',
    source: str(raw.source) ?? '',
    model: str(raw.model) ?? '',
    startedAt: num(raw.started_at),
    endedAt: num(raw.ended_at),
    lastActivityAt: num(raw.last_activity_at),
    prompts: whole(raw.total_prompts),
    toolCalls: whole(raw.total_tool_calls),
    archived: raw.archived === true || num(raw.archived) === 1,
  };
}

function rowText(raw: Record<string, unknown>, row: HistoryRow): string {
  return [
    row.id,
    row.status,
    row.project.path === '' ? 'no folder' : row.project.path,
    JSON.stringify(oneLine(str(raw.title) ?? '', 80)),
    `${row.prompts} prompts`,
    isoTime(row.startedAt),
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// history_list
// ---------------------------------------------------------------------------

/** What narrows a history_list on the route's side, before it pages: said where a page is out of reach. */
const LIST_NARROWS = 'project (one folder), dateFrom and dateTo, status or query';

/** Text in the order the database sorts it: by code unit, not by any language's rules. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest start first, the id breaking a tie: the route's own order (`started_at DESC, id DESC`). */
const newerSession = (a: Row, b: Row): number => whole(b.started_at) - whole(a.started_at) || compareText(str(b.id) ?? '', str(a.id) ?? '');

const historyList = defineTool({
  name: 'history_list',
  toolset: 'history',
  title: 'List past sessions',
  description:
    'Lists the sessions AASC has kept, archived ones included, newest first: id, title, folder, status, model, when it ' +
    'started, ended and was last active, how many prompts and tool calls, and whether it is archived. Filter by project ' +
    'folder, a text in its prompts, status or dates. 50 to a page (up to 100). A project or room central sees only ' +
    'sessions in its scope (a running one if it is in scope, an ended one if it ran in its own folders) and no total; ' +
    'it reads a limited stretch of the history per question, and says where it stopped and which filters go further. ' +
    'Titles, summaries and remarks are fenced as untrusted data.',
  risk: 'read',
  phase: 1,
  input: {
    project: z.string().min(1).max(1_024).optional().describe('Only sessions that ran in exactly this folder (absolute, or starting with ~).'),
    query: z.string().trim().min(1).max(200).optional().describe('Only sessions with a prompt that contains this text.'),
    status: z.enum(STATUSES).optional().describe('Only sessions in this status.'),
    dateFrom: DATE_INPUT.optional().describe('Only sessions that started at or after this ISO date or time.'),
    dateTo: DATE_INPUT.optional().describe('Only sessions that started at or before this ISO date or time.'),
    page: z.number().int().min(1).max(1_000).optional().describe('Which page, from 1 (default 1).'),
    pageSize: limitInput(LIST_PAGE_MAX, LIST_PAGE_DEFAULT),
  },
  async run(args, ctx) {
    const project = args.project === undefined ? undefined : writtenFolder(args.project);
    if (project !== undefined && !historyAllows(ctx)(project)) throw notInScope('folder');
    // `archived: 'all'`: the route leaves archived sessions out unless it is asked for them, and a row says if it is one.
    const filters = { query: args.query, status: args.status, dateFrom: dateMs(args.dateFrom), dateTo: dateMs(args.dateTo), archived: 'all' };
    const got = await historyPage(ctx, {
      project,
      page: args.page,
      pageSize: args.pageSize,
      byDefault: LIST_PAGE_DEFAULT,
      fetch: async (folder, page, pageSize) => {
        const body = readHistory<unknown>(await ctx.client.get('/db/sessions', queryOf({ ...filters, project: folder, page, pageSize })));
        const answer = isRecord(body) ? body : {};
        return { rows: records(answer.sessions), total: whole(answer.total), page: whole(answer.page), pageSize: whole(answer.pageSize) };
      },
      sessionOf: (raw) => raw.id,
      folderOf: (raw) => raw.project_path,
      newer: newerSession,
    });

    const built = got.shown.flatMap((raw) => {
      const row = historyRowOf(raw);
      return row === null ? [] : [{ raw, row }];
    });
    const data = {
      count: built.length,
      total: got.total,
      page: got.page,
      pageSize: got.pageSize,
      hasMore: got.beyond || got.capped,
      capped: got.capped,
      sessions: built.map((b) => b.row),
    };
    if (built.length === 0) return { data, summary: emptyWords(got, 'No sessions in the history match.', 'session', LIST_NARROWS) };
    const of = got.total === null ? '' : ` (${got.total} in all)`;
    const lead = `${plural(built.length, 'session')} on page ${got.page} of the history${of}.${moreWords(got, 'session', LIST_NARROWS)}`;
    return { data, summary: `${lead}\n${fence('aasc', 'history', built.map((b) => rowText(b.raw, b.row)).join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// history_get
// ---------------------------------------------------------------------------

interface Stamped {
  id: number;
  at: number;
  text: string;
}

const newestFirst = (a: Stamped, b: Stamped): number => b.at - a.at || b.id - a.id;

function stamped(raws: Array<Record<string, unknown>>, textKey: string, timeKey: string): Stamped[] {
  return raws.map((r) => ({ id: whole(r.id), at: whole(r[timeKey]), text: str(r[textKey]) ?? '' })).sort(newestFirst);
}

const historyGet = defineTool({
  name: 'history_get',
  toolset: 'history',
  title: 'One past session in detail',
  description:
    'Describes one kept session: its row, how many prompts, answers, tool calls, events and notes it holds, its ' +
    'newest 20 typed prompts (harness turns left out), newest 10 answers and notes (each cut short), and which ' +
    'tools it used most. Use the id history_list gives. Everything a session wrote is fenced as untrusted data. ' +
    'A project or room central may open a running session only if it is in its scope, and an ended one only if it ' +
    'ran in its own folders.',
  risk: 'read',
  phase: 1,
  input: { id: z.string().min(1).max(200).describe('A session id, as history_list shows it (the whole id).') },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get(`/db/sessions/${seg(args.id)}`));
    const detail = isRecord(body) ? body : {};
    const sessionRaw = isRecord(detail.session) ? detail.session : {};
    if (!historyVisible(ctx)(args.id, sessionRaw.project_path)) throw notInScope('session');
    const row = historyRowOf(sessionRaw) ?? historyRowOf({ id: args.id });
    const source = `session:${args.id}`;
    const promptsAll = stamped(records(detail.prompts), 'text', 'timestamp');
    const typed = promptsAll.filter((p) => !isHarnessText(p.text));
    const responses = stamped(records(detail.responses), 'text_excerpt', 'timestamp');
    const notes = records(detail.notes)
      .map((n) => ({ id: whole(n.id), createdAt: whole(n.created_at), updatedAt: whole(n.updated_at), text: str(n.text) ?? '' }))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    const toolCounts = new Map<string, number>();
    for (const call of records(detail.tool_calls)) {
      const name = str(call.tool_name) ?? '';
      if (name !== '') toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
    const tools = [...toolCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOOLS_SHOWN);
    const counts = {
      prompts: promptsAll.length,
      typedPrompts: typed.length,
      responses: responses.length,
      toolCalls: whole(records(detail.tool_calls).length),
      events: records(detail.events).length,
      notes: notes.length,
    };
    const shownPrompts = typed.slice(0, PROMPTS_SHOWN);
    const shownResponses = responses.slice(0, RESPONSES_SHOWN);
    const shownNotes = notes.slice(0, NOTES_SHOWN);
    const data = {
      id: args.id,
      session: row,
      counts,
      prompts: shownPrompts.map((p) => {
        const text = fenced(source, 'prompt', p.text, BODY_MAX);
        return { id: p.id, timestamp: p.at, text: text.value, textTruncated: text.truncated };
      }),
      responses: shownResponses.map((r) => {
        const text = fenced(source, 'response', r.text, BODY_MAX);
        return { id: r.id, timestamp: r.at, text: text.value, textTruncated: text.truncated };
      }),
      tools,
      notes: shownNotes.map((n) => {
        const text = fenced(source, 'note', n.text, BODY_MAX);
        return { id: n.id, createdAt: n.createdAt, updatedAt: n.updatedAt, text: text.value, textTruncated: text.truncated };
      }),
    };
    const rows = [
      `title ${JSON.stringify(oneLine(str(sessionRaw.title) ?? '', 120))} · ${row?.project.path ?? ''}`,
      ...shownPrompts.map((p) => `prompt ${isoTime(p.at)}: ${JSON.stringify(oneLine(p.text, ROW_TEXT))}`),
      ...shownResponses.map((r) => `answer ${isoTime(r.at)}: ${JSON.stringify(oneLine(r.text, ROW_TEXT))}`),
      ...shownNotes.map((n) => `note ${isoTime(n.updatedAt)}: ${JSON.stringify(oneLine(n.text, ROW_TEXT))}`),
      ...(tools.length === 0 ? [] : [`tools: ${tools.map((t) => `${t.name}×${t.count}`).join(', ')}`]),
    ];
    const lead =
      `Session ${plain(args.id, 80)} from the history: ${plain(row?.status ?? '', 20) || 'no status'}, ` +
      `${plural(counts.typedPrompts, 'typed prompt')}, ${plural(counts.responses, 'answer')}, ${plural(counts.toolCalls, 'tool call')}, ${plural(counts.notes, 'note')}.`;
    return { data, summary: `${lead}\n${fence(source, 'history', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// history_projects and history_known_projects
// ---------------------------------------------------------------------------

const historyProjects = defineTool({
  name: 'history_projects',
  toolset: 'history',
  title: 'Project folders in the history',
  description:
    'Lists the project folders the kept sessions ran in, with each folder’s name. A project or room central sees ' +
    'only its own folders. 100 to a page, up to 500; pass nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: { cursor: CURSOR_INPUT, limit: limitInput(NAMES_MAX, NAMES_DEFAULT) },
  async run(args, ctx) {
    const allows = historyAllows(ctx);
    const body = readHistory<unknown>(await ctx.client.get('/db/projects'));
    const all = records(body)
      .map((r) => ({ path: str(r.project_path) ?? '', name: str(r.project_name) ?? '' }))
      .filter((p) => p.path !== '' && allows(p.path));
    const page = pageOf(all.length, args.cursor, args.limit ?? NAMES_DEFAULT);
    const shown = all.slice(page.start, page.end);
    const data = { count: all.length, start: page.start, returned: shown.length, nextCursor: page.next, projects: shown };
    if (all.length === 0) return { data, summary: 'No projects in the history.' };
    if (shown.length === 0) return { data, summary: 'The cursor is past the end of the list.' };
    const { more } = pageWords(page, all.length);
    return {
      data,
      summary: `${plural(all.length, 'project folder')} in the history.${more}\n${fence('aasc', 'projects', shown.map((p) => `${p.path} · ${p.name}`).join('\n'))}`,
    };
  },
});

const historyKnownProjects = defineTool({
  name: 'history_known_projects',
  toolset: 'history',
  title: 'Folders Claude Code has run in',
  description:
    'Lists the folders Claude Code has a project for on this Mac (from ~/.claude/projects), including ones with ' +
    'no session AASC kept. A project or room central sees only its own folders. 100 to a page, up to 500; pass ' +
    'nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: { cursor: CURSOR_INPUT, limit: limitInput(NAMES_MAX, NAMES_DEFAULT) },
  async run(args, ctx) {
    const allows = historyAllows(ctx);
    const body = readHistory<unknown>(await ctx.client.get('/known-projects'));
    // The route ranks folders most used first, which moves with every hook; paging needs a fixed order.
    const all = strings(isRecord(body) ? body.paths : []).filter((p) => p !== '' && allows(p)).sort();
    const page = pageOf(all.length, args.cursor, args.limit ?? NAMES_DEFAULT);
    const shown = all.slice(page.start, page.end);
    const data = { count: all.length, start: page.start, returned: shown.length, nextCursor: page.next, paths: shown };
    if (all.length === 0) return { data, summary: 'No folders known to Claude Code.' };
    if (shown.length === 0) return { data, summary: 'The cursor is past the end of the list.' };
    const { more } = pageWords(page, all.length);
    return { data, summary: `${plural(all.length, 'folder')} known to Claude Code.${more}\n${fence('aasc', 'folders', shown.join('\n'))}` };
  },
});

export const historyTools: readonly ToolDef[] = [historyList, historyGet, ...historySearchTools, historyProjects, historyKnownProjects, historyDeleteTool];
