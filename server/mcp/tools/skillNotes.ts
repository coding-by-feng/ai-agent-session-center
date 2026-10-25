// tools/skillNotes.ts — the skill-notes toolset, P1: the favourites, tags and abbreviations the person keeps for
// their skills and commands. Read only here; setting them (P3) is in skillNoteWrite.ts.
//
// The notes live in the person's AASC Cloud account; this Mac holds no copy. The route that reads them is
// `GET /api/skill-notes/favorites`: the Mac pulls the account's notes through its cloud connection, keeps the
// answer for a minute and gives `{ key, fav, tags, abbr }` per note, keyed `agent:name`. With no connection it
// answers an empty list (`source: 'none'`). That route needs no cloud binding headers and is the one source the Mac
// already caches; paging the cloud notes route here would ask the backend afresh on every call.
//
// A note carries no free text: a tag and an abbreviation are short words the notes schema restricts (letters,
// digits, `_` and `-`), and a key names a skill. So nothing here is fenced in `data`; the rows in the text sit in
// one block, so a name with odd characters in it stays inside it.

import type { ToolDef } from '../registry.js';
import { defineTool, fence, isRecord, plural, unwrap } from './define.js';
import { skillNoteWriteTools } from './skillNoteWrite.js';
import { limitInput, records, str, strings } from './shape.js';

const SHOWN_DEFAULT = 200;
const SHOWN_MAX = 1_000;
const AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'shared']);

interface NoteView {
  key: string;
  /** The agent the key names; null for a key that names none of the three. */
  agent: string | null;
  /** What follows the agent in the key: the skill or command name (a plugin’s is `plugin:name`). */
  name: string;
  fav: boolean;
  tags: string[];
  abbr: string | null;
}

function noteOf(raw: Record<string, unknown>): NoteView | null {
  const key = str(raw.key);
  if (key === null || key === '') return null;
  const colon = key.indexOf(':');
  const head = colon < 0 ? '' : key.slice(0, colon);
  const abbr = str(raw.abbr);
  return {
    key,
    agent: AGENTS.has(head) ? head : null,
    name: colon < 0 ? key : key.slice(colon + 1),
    fav: raw.fav === true,
    tags: strings(raw.tags),
    abbr: abbr === null || abbr === '' ? null : abbr,
  };
}

function rowOf(n: NoteView): string {
  return [n.fav ? '★' : '·', n.key, n.tags.length > 0 ? `tags ${n.tags.join(', ')}` : null, n.abbr === null ? null : `abbr ${n.abbr}`]
    .filter((p): p is string => p !== null)
    .join(' · ');
}

const skillnoteList = defineTool({
  name: 'skillnote_list',
  toolset: 'skillNotes',
  title: 'List skill notes',
  description:
    'Lists the person’s skill notes: for each skill or command the key (agent:name), whether it is a favourite, ' +
    'its tags and its abbreviation. Favourites first, then notes with an abbreviation. Read through the AASC ' +
    'Cloud connection; empty (source none) when this Mac is not connected. 200 by default, up to 1 000.',
  risk: 'read',
  phase: 1,
  input: { limit: limitInput(SHOWN_MAX, SHOWN_DEFAULT) },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get('/skill-notes/favorites'));
    const answer = isRecord(body) ? body : {};
    const all = records(answer.entries).flatMap((raw) => {
      const note = noteOf(raw);
      return note === null ? [] : [note];
    });
    const shown = all.slice(0, args.limit ?? SHOWN_DEFAULT);
    const source = answer.source === 'cloud' ? 'cloud' : 'none';
    const data = { source, count: all.length, shown: shown.length, notes: shown };
    if (all.length === 0) {
      return {
        data,
        summary:
          source === 'none'
            ? 'No skill notes: this Mac is not connected to AASC Cloud, so there are none to read.'
            : 'The account has no skill notes (no favourites, tags or abbreviations).',
      };
    }
    const more = all.length > shown.length ? `; the first ${shown.length} are listed` : '';
    return {
      data,
      summary: `${plural(all.length, 'skill note')}${more}.\n${fence('aasc', 'skill-notes', shown.map(rowOf).join('\n'))}`,
    };
  },
});

export const skillNoteTools: readonly ToolDef[] = [skillnoteList, ...skillNoteWriteTools];
