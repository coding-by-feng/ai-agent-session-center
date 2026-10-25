// tools/historyRead.ts — how the history tools read a page of a history route for the central that asked, and how they
// word what lies beyond that page. history_list and history_prompts share it.
//
// A global central sees all of the history, so its page is the route's own: the route counts, orders and pages it.
//
// A central that sees only part of it (Rulings 32 and 36, historyScope.ts) cannot be given the route's page, because the
// route counts and pages rows the central may not see. Its rows are read here, a route page (200 rows) at a time, kept
// when `historyVisible` allows them, merged newest first, and cut into the page asked for. To read as little as it can,
// it asks the route about one folder at a time: the folders the central may see come from the history's own list of
// folders, and the route filters each by exact folder, before it pages. A central with more than `MAX_FOLDERS` such
// folders, or one that may see a live session the history files under no folder, has its history read whole instead (no
// folder filter), the rows it may not see dropped here.
//
// One question reads at most `SCAN_PAGES` route pages in all, so a page far enough into the history is out of reach.
// Each call starts again at the newest row, which is why "ask for page N+1" is only said when a row beyond this page has
// been seen; where the read stopped first, the words say how far it looked and point to the filters the route applies
// before it pages: a folder, dates, a session, a text.

import type { ToolContext } from '../registry.js';
import { SESSION_STATUS } from '../../constants.js';
import { plural } from './define.js';
import { historyAllows, historyVisible, isFolder, isScoped, readHistory } from './historyScope.js';
import { records, str } from './shape.js';

/** Rows asked of a route per page when a scoped central's rows are read here: the most a route gives. */
export const SCAN_PAGE = 200;
/**
 * Route pages one question reads for a scoped central. The server limits how fast `/db/search` and `/db/prompts` can be
 * asked (5 and 10 a second per address), and this keeps one question under the second of those.
 */
export const SCAN_PAGES = 8;
/** The most folders asked about one by one; more than this and the history is read whole. */
export const MAX_FOLDERS = 6;

export type Row = Record<string, unknown>;

/** One page of a history route, read loosely. */
export interface RoutePage {
  rows: Row[];
  /** Every row the route has for those filters, on all its pages. */
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Reading a scoped central's rows
// ---------------------------------------------------------------------------

interface Stream {
  /** The exact folder the route is asked about; undefined for a read of the whole history. */
  readonly folder: string | undefined;
  /** The next route page to read. */
  readonly next: number;
  /** The route has no page after the last one read. */
  readonly done: boolean;
  /** Every row read, in the route's order (newest first), seen by this central or not. */
  readonly read: readonly Row[];
}

interface ScopedRead {
  /** What the central may see, newest first, as far as it is certain of the order. */
  rows: Row[];
  /** Everything the route has for these streams was read: nothing lies beyond `rows`. */
  exhausted: boolean;
  /** Route rows read, whoever may see them. */
  looked: number;
}

/**
 * Reads the streams a page at a time until `want` rows the central may see are certain, every stream is out, or
 * `SCAN_PAGES` pages are read. A row is certain once it is at least as new as the last row of every stream not yet out:
 * what a stream has not yet read is older than that. The stream whose last row is the newest is the one holding the
 * order back, so it is the one read next.
 */
async function readScoped(
  folders: ReadonlyArray<string | undefined>,
  fetchPage: (folder: string | undefined, page: number) => Promise<{ rows: Row[]; more: boolean }>,
  keep: (raw: Row) => boolean,
  newer: (a: Row, b: Row) => number,
  want: number,
): Promise<ScopedRead> {
  let streams: Stream[] = folders.map((folder) => ({ folder, next: 1, done: false, read: [] }));
  let pages = 0;
  const advance = async (at: number): Promise<void> => {
    const stream = streams[at];
    const got = await fetchPage(stream.folder, stream.next);
    pages += 1;
    streams = streams.map((s, i) => (i === at ? { ...s, next: s.next + 1, done: !got.more, read: [...s.read, ...got.rows] } : s));
  };
  for (let at = 0; at < streams.length; at += 1) await advance(at);

  for (;;) {
    const merged = streams.flatMap((s) => s.read).filter(keep).sort(newer);
    const looked = streams.reduce((n, s) => n + s.read.length, 0);
    const open = streams.flatMap((s, at) => (s.done ? [] : [{ at, last: s.read[s.read.length - 1] as Row | undefined }]));
    if (open.length === 0) return { rows: merged, exhausted: true, looked };
    // A stream that has given no row has no last row to bound the order by: it is read before anything is certain.
    const blind = open.find((o) => o.last === undefined);
    if (blind !== undefined) {
      if (pages >= SCAN_PAGES) return { rows: [], exhausted: false, looked };
      await advance(blind.at);
      continue;
    }
    const lead = open.reduce((a, b) => (newer(a.last as Row, b.last as Row) <= 0 ? a : b));
    const edge = merged.findIndex((r) => newer(r, lead.last as Row) > 0);
    const certain = edge === -1 ? merged : merged.slice(0, edge);
    if (certain.length >= want || pages >= SCAN_PAGES) return { rows: certain, exhausted: false, looked };
    await advance(lead.at);
  }
}

/**
 * The folders to ask the route about, one read each; `[undefined]` is one read of the whole history. A folder the caller
 * named is the only one asked about. A caller that narrowed the rows some other way (a session id) needs no folder
 * questions. Otherwise the folders are those of the history the central may see (the folder rule), if there are few
 * enough, and if no live session in its scope lacks a folder: a row filed under no folder cannot be found by one.
 */
async function folderStreams(ctx: ToolContext, project: string | undefined, narrowed: boolean): Promise<Array<string | undefined>> {
  if (project !== undefined) return [project];
  if (narrowed) return [undefined];
  if (ctx.scopedSessions().some((s) => s.status !== SESSION_STATUS.ENDED && !isFolder(s.projectPath))) return [undefined];
  const body = readHistory<unknown>(await ctx.client.get('/db/projects'));
  if (!Array.isArray(body)) return [undefined];
  const allows = historyAllows(ctx);
  const folders = [...new Set(records(body).flatMap((r) => (allows(str(r.project_path)) ? [str(r.project_path) as string] : [])))];
  return folders.length <= MAX_FOLDERS ? folders : [undefined];
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

export interface HistorySpec {
  /** The folder the caller named, already checked against the central's scope: the route filters by it exactly. */
  project: string | undefined;
  /** The caller's own filter (a session id) narrows what the route gives well enough: no folder questions. */
  narrowed?: boolean;
  /** The page and the page size as the caller gave them; undefined when it gave none. */
  page: number | undefined;
  pageSize: number | undefined;
  /** How many rows a page holds when the caller did not say. */
  byDefault: number;
  /** Asks the route for one page. `page` and `pageSize` are undefined when the caller gave none. */
  fetch: (folder: string | undefined, page: number | undefined, pageSize: number | undefined) => Promise<RoutePage>;
  /** The session a row belongs to, and the folder it is filed under. */
  sessionOf: (raw: Row) => unknown;
  folderOf: (raw: Row) => unknown;
  /** Rows to leave out whoever asks. */
  only?: (raw: Row) => boolean;
  /** Orders two rows of the route, newest first. */
  newer: (a: Row, b: Row) => number;
}

export interface HistoryPage {
  shown: Row[];
  /** All the rows the route has: said only to a central that sees all of them. */
  total: number | null;
  page: number;
  pageSize: number;
  /** A row exists after this page: asking for the next page shows it. */
  beyond: boolean;
  /** The read stopped at its limit with no row seen beyond this page: another page will not go further. */
  capped: boolean;
  /** Route rows read to find what a scoped central sees; null when the route paged it. */
  looked: number | null;
}

/** The page of the history a central is given, however much of it that central may see. */
export async function historyPage(ctx: ToolContext, spec: HistorySpec): Promise<HistoryPage> {
  const page = spec.page ?? 1;
  const asked = spec.pageSize ?? spec.byDefault;
  const only = spec.only ?? (() => true);

  if (!isScoped(ctx)) {
    const route = await spec.fetch(spec.project, spec.page, spec.pageSize);
    const pageSize = route.pageSize || asked;
    const beyond = (route.page || page) * pageSize < route.total;
    return { shown: route.rows.filter(only), total: route.total, page, pageSize, beyond, capped: false, looked: null };
  }

  const visible = historyVisible(ctx);
  const keep = (raw: Row): boolean => only(raw) && visible(spec.sessionOf(raw), spec.folderOf(raw));
  const folders = await folderStreams(ctx, spec.project, spec.narrowed === true);
  const end = page * asked;
  const read = await readScoped(
    folders,
    async (folder, n) => {
      const got = await spec.fetch(folder, n, SCAN_PAGE);
      return { rows: got.rows, more: n * SCAN_PAGE < got.total };
    },
    keep,
    spec.newer,
    end + 1,
  );
  const beyond = read.rows.length > end;
  return {
    shown: read.rows.slice(end - asked, end),
    total: null,
    page,
    pageSize: asked,
    beyond,
    capped: !read.exhausted && !beyond,
    looked: read.looked,
  };
}

// ---------------------------------------------------------------------------
// Words for what lies beyond a page
// ---------------------------------------------------------------------------

type Facts = Pick<HistoryPage, 'page' | 'beyond' | 'capped' | 'looked'>;

/**
 * What follows a page's count: where the rest is, or why paging cannot reach it. `what` is the singular of the rows
 * ("session"); `narrow` names the filters the route applies before it pages.
 */
export function moreWords(f: Facts, what: string, narrow: string): string {
  if (f.beyond) return ` There is more: ask for page ${f.page + 1}.`;
  if (!f.capped) return '';
  return (
    ` It stopped after reading ${plural(f.looked ?? 0, what)} (its limit for one question), so older ones may match, ` +
    `and another page will not go further: narrow it with ${narrow}.`
  );
}

/** What an empty page says: `none` when the history has nothing for these filters. */
export function emptyWords(f: Facts, none: string, what: string, narrow: string): string {
  if (f.beyond) return `Nothing to show on page ${f.page}, but there is more: ask for page ${f.page + 1}.`;
  if (f.capped) {
    return `It read ${plural(f.looked ?? 0, what)} and none was left to show here, then stopped (its limit for one question). Older ones may match: narrow it with ${narrow}.`;
  }
  return f.page > 1 ? `Page ${f.page} is past the end: nothing follows the last page.` : none;
}
