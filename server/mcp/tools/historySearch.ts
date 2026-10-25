// tools/historySearch.ts — the two history tools that search text: `history_search` (full text over prompts and
// answers, `GET /api/db/search`) and `history_prompts` (the prompts a person typed, `GET /api/db/prompts`). Read
// only; both routes are rate-limited by the server, which a tool reports as "wait a second".
//
// What was typed and answered is what sessions and people wrote: each text is fenced as untrusted in `data`, and
// the rows in the text sit in one block. Which rows a central sees is historyScope.ts (Rulings 32 and 36). A search hit
// names only a session id and a project's name, so for a scoped central the folder of each hit's session is looked
// up (a live session needs none: its scope decides): first among the sessions the store holds, then in the newest
// pages of the history's own session list, archived sessions included. A search page is the route's own page, so
// "ask for page N+1" always reaches the next one; history_prompts reads its pages through historyRead.ts.

import { z } from 'zod';
import { SESSION_STATUS } from '../../constants.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { defineTool, fence, isRecord, notInScope, oneLine, plural, writtenFolder } from './define.js';
import { emptyWords, historyPage, moreWords, SCAN_PAGE, type Row } from './historyRead.js';
import { DATE_INPUT, dateMs, historyAllows, historyVisible, isFolder, isHarnessText, isScoped, readHistory } from './historyScope.js';
import { fenced, isoTime, limitInput, queryOf, records, str, whole } from './shape.js';

const SEARCH_PAGE_MAX = 50;
const PROMPTS_PAGE_DEFAULT = 50;
const PROMPTS_PAGE_MAX = 100;
const HIT_TEXT_MAX = 500;
const PROMPT_TEXT_MAX = 1_500;
const TITLE_MAX = 300;
const ROW_TEXT = 160;
/** Pages of the history's session list read to find the folder of a hit no live session answers for. */
const LOOKUP_PAGES = 5;

const PAGE_INPUT = z.number().int().min(1).max(1_000).optional().describe('Which page, from 1 (default 1).');

// ---------------------------------------------------------------------------
// history_search
// ---------------------------------------------------------------------------

interface Hit {
  sessionId: string;
  projectName: string;
  type: 'prompt' | 'response';
  text: string;
  timestamp: number;
}

/**
 * The folder each session id of `ids` ran in: the sessions the store holds first, then the history's own session list,
 * newest first, archived sessions included. A live session is not looked up: its scope decides, not its folder.
 */
async function foldersOf(ctx: ToolContext, ids: ReadonlySet<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const live = new Set<string>();
  for (const s of ctx.sessions()) {
    if (!ids.has(s.sessionId)) continue;
    if (isFolder(s.projectPath)) found.set(s.sessionId, s.projectPath);
    if (s.status !== SESSION_STATUS.ENDED) live.add(s.sessionId);
  }
  const missing = new Set([...ids].filter((id) => !found.has(id) && !live.has(id)));
  for (let page = 1; page <= LOOKUP_PAGES && missing.size > 0; page += 1) {
    const body = readHistory<unknown>(await ctx.client.get('/db/sessions', { page, pageSize: SCAN_PAGE, archived: 'all' }));
    const answer = isRecord(body) ? body : {};
    for (const raw of records(answer.sessions)) {
      const id = str(raw.id);
      if (id !== null && missing.delete(id)) found.set(id, str(raw.project_path) ?? '');
    }
    if (page * SCAN_PAGE >= whole(answer.total)) break;
  }
  return found;
}

const historySearch = defineTool({
  name: 'history_search',
  toolset: 'history',
  title: 'Search the history',
  description:
    'Searches the text of every kept session’s prompts and answers for a text: which session, its project, whether ' +
    'a prompt or an answer matched, when, and the matching text (cut at 500 characters, fenced as untrusted data). ' +
    'The server limits how fast it can be asked (wait a second and ask again). A project or room central finds ' +
    'only text from sessions in its scope (a running one if it is in scope, an ended one if it ran in its own ' +
    'folders), and no total. 50 hits to a page.',
  risk: 'read',
  phase: 1,
  input: {
    query: z.string().trim().min(1).max(200).describe('The text to look for, anywhere in a prompt or an answer.'),
    type: z.enum(['all', 'prompts', 'responses']).optional().describe('Search prompts only, answers only, or both (default both).'),
    page: PAGE_INPUT,
    pageSize: limitInput(SEARCH_PAGE_MAX, SEARCH_PAGE_MAX),
  },
  async run(args, ctx) {
    const body = readHistory<unknown>(await ctx.client.get('/db/search', queryOf({ query: args.query, type: args.type, page: args.page, pageSize: args.pageSize })));
    const answer = isRecord(body) ? body : {};
    const hits: Hit[] = records(answer.results)
      .map((h) => ({
        sessionId: str(h.session_id) ?? '',
        projectName: str(h.project_name) ?? '',
        type: h.type === 'response' ? ('response' as const) : ('prompt' as const),
        text: str(h.text) ?? '',
        timestamp: whole(h.timestamp),
      }))
      .filter((h) => h.sessionId !== '');
    const page = whole(answer.page) || args.page || 1;
    const pageSize = whole(answer.pageSize) || args.pageSize || SEARCH_PAGE_MAX;
    let kept = hits;
    let total: number | null = whole(answer.total);
    let hasMore = page * pageSize < total;
    if (isScoped(ctx)) {
      const visible = historyVisible(ctx);
      const folders = await foldersOf(ctx, new Set(hits.map((h) => h.sessionId)));
      kept = hits.filter((h) => visible(h.sessionId, folders.get(h.sessionId)));
      total = null;
      hasMore = hits.length >= pageSize;
    }
    const data = {
      type: args.type ?? 'all',
      page,
      pageSize,
      total,
      hasMore,
      count: kept.length,
      results: kept.map((h) => {
        const text = fenced(`session:${h.sessionId}`, h.type, h.text, HIT_TEXT_MAX);
        return { sessionId: h.sessionId, projectName: h.projectName, type: h.type, text: text.value, textTruncated: text.truncated, timestamp: h.timestamp };
      }),
    };
    if (kept.length === 0) {
      return { data, summary: hasMore ? 'Nothing on this page matches; there may be more on the next one.' : 'Nothing in the history matches.' };
    }
    const of = total === null ? '' : ` of ${total}`;
    const more = hasMore ? ` There may be more: ask for page ${page + 1}.` : '';
    const rows = kept.map((h) => `${isoTime(h.timestamp)} · ${h.type} · ${h.sessionId} · ${h.projectName} · ${JSON.stringify(oneLine(h.text, ROW_TEXT))}`);
    return { data, summary: `${plural(kept.length, 'hit')}${of} on page ${page}.${more}\n${fence('aasc', 'history-search', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// history_prompts
// ---------------------------------------------------------------------------

interface PromptRow {
  id: number;
  sessionId: string;
  sessionTitle: string | null;
  project: string | null;
  timestamp: number;
  text: string;
}

function promptOf(raw: Record<string, unknown>): PromptRow {
  const project = str(raw.project_path);
  const title = str(raw.session_title);
  return {
    id: whole(raw.id),
    sessionId: str(raw.session_id) ?? '',
    sessionTitle: title,
    project: project === null || project === '' ? null : project,
    timestamp: whole(raw.timestamp),
    text: str(raw.text) ?? '',
  };
}

/** What narrows a history_prompts on the route's side, before it pages: said where a page is out of reach. */
const PROMPT_NARROWS = 'project (one folder), session, dateFrom and dateTo, or query';

/** Newest prompt first, the id breaking a tie: the route's own order (`timestamp DESC, id DESC`). */
const newerPrompt = (a: Row, b: Row): number => whole(b.timestamp) - whole(a.timestamp) || whole(b.id) - whole(a.id);

const historyPrompts = defineTool({
  name: 'history_prompts',
  toolset: 'history',
  title: 'Prompts a person typed',
  description:
    'Lists the prompts a person typed to sessions, newest first, with the session, its title, its folder and ' +
    'when (the harness’s own turns, which start with <, are left out). Filter by folder, session, a text in the ' +
    'prompt or dates. Each text is cut at 1 500 characters and fenced as untrusted data. The server limits how fast ' +
    'it can be asked. A project or room central sees only prompts of sessions in its scope (a running one if it is in ' +
    'scope, an ended one if it ran in its own folders) and no total; it reads a limited stretch of the history per ' +
    'question, and says where it stopped and which filters go further. 50 to a page (up to 100).',
  risk: 'read',
  phase: 1,
  input: {
    project: z.string().min(1).max(1_024).optional().describe('Only prompts sent in exactly this folder (absolute, or starting with ~).'),
    session: z.string().min(1).max(200).optional().describe('Only prompts of this session (its whole id, as history_list shows it).'),
    query: z.string().trim().min(1).max(200).optional().describe('Only prompts that contain this text.'),
    dateFrom: DATE_INPUT.optional().describe('Only prompts at or after this ISO date or time.'),
    dateTo: DATE_INPUT.optional().describe('Only prompts at or before this ISO date or time.'),
    page: PAGE_INPUT,
    pageSize: limitInput(PROMPTS_PAGE_MAX, PROMPTS_PAGE_DEFAULT),
  },
  async run(args, ctx) {
    const project = args.project === undefined ? undefined : writtenFolder(args.project);
    if (project !== undefined && !historyAllows(ctx)(project)) throw notInScope('folder');
    const filters = { kind: 'mine', session: args.session, query: args.query, dateFrom: dateMs(args.dateFrom), dateTo: dateMs(args.dateTo) };
    const got = await historyPage(ctx, {
      project,
      // A session id narrows the route's rows to one session's own: there is no need to ask folder by folder.
      narrowed: args.session !== undefined,
      page: args.page,
      pageSize: args.pageSize,
      byDefault: PROMPTS_PAGE_DEFAULT,
      fetch: async (folder, page, pageSize) => {
        const body = readHistory<unknown>(await ctx.client.get('/db/prompts', queryOf({ ...filters, project: folder, page, pageSize })));
        const answer = isRecord(body) ? body : {};
        return { rows: records(answer.prompts), total: whole(answer.total), page: whole(answer.page), pageSize: whole(answer.pageSize) };
      },
      sessionOf: (raw) => raw.session_id,
      folderOf: (raw) => raw.project_path,
      only: (raw) => !isHarnessText(str(raw.text) ?? ''),
      newer: newerPrompt,
    });

    const rows = got.shown.map((raw) => promptOf(raw));
    const data = {
      count: rows.length,
      total: got.total,
      page: got.page,
      pageSize: got.pageSize,
      hasMore: got.beyond || got.capped,
      capped: got.capped,
      prompts: rows.map((row) => {
        const source = `session:${row.sessionId}`;
        const text = fenced(source, 'prompt', row.text, PROMPT_TEXT_MAX);
        return {
          id: row.id,
          sessionId: row.sessionId,
          sessionTitle: row.sessionTitle === null ? null : fenced(source, 'title', row.sessionTitle, TITLE_MAX).value,
          project: row.project,
          timestamp: row.timestamp,
          text: text.value,
          textTruncated: text.truncated,
        };
      }),
    };
    if (rows.length === 0) return { data, summary: emptyWords(got, 'No typed prompts match.', 'prompt', PROMPT_NARROWS) };
    const of = got.total === null ? '' : ` of ${got.total}`;
    const lines = rows.map((row) => `${isoTime(row.timestamp)} · ${row.sessionId} · ${JSON.stringify(oneLine(row.text, ROW_TEXT))}`);
    const lead = `${plural(rows.length, 'typed prompt')}${of}, page ${got.page}.${moreWords(got, 'prompt', PROMPT_NARROWS)}`;
    return { data, summary: `${lead}\n${fence('aasc', 'history-prompts', lines.join('\n'))}` };
  },
});

export const historySearchTools: readonly ToolDef[] = [historySearch, historyPrompts];
