// tools/snippets.ts — the saved-prompts toolset: the person's curated library of prompts. P1: `snippet_list`, read
// only. P2: `snippet_use` (write): mark one used and get its text. P3: `snippet_create` and `snippet_rename` (ask) are in
// snippetWrite.ts. P5: `snippet_delete` (destructive) is in deletes.ts.
//
// `GET /api/snippets` answers the whole list (at most 500 prompts of up to 64 KB). A saved prompt is text the
// person wrote to send later, and `snippet_list` gives a central it as data: each text is fenced as untrusted in
// `data` (cut at 2 000 characters, with its real length), and the rows in the text sit in one block. Names, ids,
// counts and times stay plain. The list belongs to the Mac, not to a session: every central that has the toolset may
// read it.
//
// `snippet_use` is the other way round: it is the central being handed the person's prompt to send (prompt_send) or
// queue, whole and plain: fencing it would put the tags into the prompt it is meant to send. The plan's ruling
// (P2 Task 7): it is the person's own library, returned plain.

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { snippetDeleteTool } from './deletes.js';
import { defineTool, fence, isRecord, oneLine, plural, unwrap } from './define.js';
import { snippetWriteTools } from './snippetWrite.js';
import { CURSOR_INPUT, fenced, limitInput, num, pageOf, pageWords, records, str, whole } from './shape.js';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const TEXT_MAX = 2_000;
const ROW_TEXT = 100;

interface Snippet {
  id: number;
  label: string;
  text: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

function snippetOf(raw: Record<string, unknown>): Snippet | null {
  const id = num(raw.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    label: str(raw.label) ?? '',
    text: str(raw.text) ?? '',
    useCount: whole(raw.useCount),
    lastUsedAt: num(raw.lastUsedAt),
    createdAt: whole(raw.createdAt),
  };
}

const snippetList = defineTool({
  name: 'snippet_list',
  toolset: 'snippets',
  title: 'List saved prompts',
  description:
    'Lists the person’s saved prompts, newest first: id, name, how often and when each was used, and its text ' +
    '(cut at 2 000 characters, fenced as untrusted data). Filter by a text in the prompt or its name. 50 to a ' +
    'page, up to 200; pass nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: {
    query: z.string().trim().min(1).max(200).optional().describe('Only prompts with this text in the prompt or its name (any case).'),
    cursor: CURSOR_INPUT,
    limit: limitInput(PAGE_MAX, PAGE_DEFAULT),
  },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get('/snippets'));
    const answer = isRecord(body) ? body : {};
    const all = records(answer.snippets).flatMap((raw) => {
      const snippet = snippetOf(raw);
      return snippet === null ? [] : [snippet];
    });
    const needle = args.query?.toLowerCase();
    const found = needle === undefined ? all : all.filter((s) => s.text.toLowerCase().includes(needle) || s.label.toLowerCase().includes(needle));
    const page = pageOf(found.length, args.cursor, args.limit ?? PAGE_DEFAULT);
    const shown = found.slice(page.start, page.end);
    const data = {
      revision: whole(answer.revision),
      total: all.length,
      count: found.length,
      start: page.start,
      returned: shown.length,
      nextCursor: page.next,
      snippets: shown.map((s) => {
        const text = fenced(`snippet:${s.id}`, 'snippet', s.text, TEXT_MAX);
        return {
          id: s.id,
          label: s.label,
          text: text.value,
          textTruncated: text.truncated,
          textLength: text.length,
          useCount: s.useCount,
          lastUsedAt: s.lastUsedAt,
          createdAt: s.createdAt,
        };
      }),
    };
    if (all.length === 0) return { data, summary: 'No saved prompts.' };
    if (shown.length === 0) return { data, summary: found.length === 0 ? 'No saved prompt matches that text.' : 'The cursor is past the end of the list.' };
    const { of, range, more } = pageWords(page, found.length, all.length);
    const rows = shown.map((s) => `#${s.id} · ${s.label === '' ? 'no name' : JSON.stringify(s.label)} · used ${s.useCount}× · ${JSON.stringify(oneLine(s.text, ROW_TEXT))}`);
    return {
      data,
      summary: `${plural(found.length, 'saved prompt')}${of}${range}.${more}\n${fence('aasc', 'snippets', rows.join('\n'))}`,
    };
  },
});

const snippetUse = defineTool({
  name: 'snippet_use',
  toolset: 'snippets',
  title: 'Use a saved prompt',
  description:
    'Marks one of the person’s saved prompts as used (the count and time the Saved prompts list shows) and gives back ' +
    'its text, whole and plain, to send with prompt_send or to queue. id is the number snippet_list shows after the #. ' +
    'It sends nothing by itself.',
  risk: 'write',
  phase: 2,
  input: {
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('The saved prompt’s number, as snippet_list shows it (#3 is 3).'),
  },
  async run(args, ctx) {
    const answer = await ctx.client.post(`/snippets/${args.id}/use`);
    if (answer.status === 404) {
      throw new ToolError('NOT_FOUND', 'No saved prompt has that id.', 'snippet_list shows the saved prompts and their ids.');
    }
    const body = unwrap<unknown>(answer);
    const used = records(isRecord(body) ? body.snippets : undefined)
      .map(snippetOf)
      .find((s) => s !== null && s.id === args.id);
    if (used === undefined || used === null) {
      throw new ToolError('UPSTREAM', 'AASC marked the saved prompt used but did not give it back.', 'Try snippet_list, then use it again.');
    }
    const name = used.label === '' ? 'no name' : JSON.stringify(used.label);
    return {
      data: { id: used.id, label: used.label, text: used.text, useCount: used.useCount, lastUsedAt: used.lastUsedAt },
      summary: `Saved prompt #${used.id} (${name}) marked used, ${plural(used.useCount, 'use')} in all. Its text, to send with prompt_send or to queue:\n${used.text}`,
      activity: [{ summary: `Used saved prompt #${used.id}.`, detail: { snippetId: used.id, useCount: used.useCount } }],
    };
  },
});

export const snippetTools: readonly ToolDef[] = [snippetList, snippetUse, ...snippetWriteTools, snippetDeleteTool];
