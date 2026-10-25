// tools/notes.ts — the notes toolset, P1: a session's notes, and what one note's image or video is. Read only here;
// writing a note and attaching media (P3) are in noteWrite.ts, and deleting one (P5, `note_delete`) is in deletes.ts.
//
// A note is Markdown a person wrote about a session: each text is fenced as untrusted in `data` (cut at 4 000
// characters, with its real length), and the rows in the text sit in one block. A note embeds an image or a video
// as a link `/api/note-media/<id>`; `note_list` names the ids it finds, and `note_media_get` describes one: its
// type, size and the session it belongs to, never its bytes. The bytes are not available through MCP in P1 (the
// MCP resource `aasc://notes/media/<id>` answers this same description). The description comes from
// `GET /api/note-media/:id/meta`, whose answer names the owning session; the owner must be one the central may see,
// or a global central.

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { noteDeleteTool } from './deletes.js';
import { defineTool, fence, isRecord, notInScope, oneLine, plural, refOf, resolveTarget, seg, SESSION_REF, sessionSource, unwrap } from './define.js';
import { noteWriteTools } from './noteWrite.js';
import { fenced, isoTime, limitInput, num, records, str, whole } from './shape.js';

const SHOWN_DEFAULT = 50;
const SHOWN_MAX = 100;
const TEXT_MAX = 4_000;
const ROW_TEXT = 160;

/** A note media id: what the server makes (16 random bytes, hex). */
const MEDIA_ID = z
  .string()
  .regex(/^[a-f0-9]{32}$/)
  .describe('A note media id, as note_list shows it (32 hex characters).');

/** The link a note holds for an embedded file. */
const MEDIA_LINK = /\/api\/note-media\/([a-f0-9]{32})/g;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/i;

/** The media ids a note's text links to, each once, in the order they first appear. */
function mediaIn(text: string): string[] {
  return [...new Set([...text.matchAll(MEDIA_LINK)].map((m) => m[1]))];
}

// ---------------------------------------------------------------------------
// note_list
// ---------------------------------------------------------------------------

interface Note {
  id: number;
  createdAt: number;
  updatedAt: number;
  text: string;
}

function noteOf(raw: Record<string, unknown>): Note | null {
  const id = num(raw.id);
  if (id === null) return null;
  return { id, createdAt: whole(raw.created_at), updatedAt: whole(raw.updated_at), text: str(raw.text) ?? '' };
}

const noteList = defineTool({
  name: 'note_list',
  toolset: 'notes',
  title: 'A session’s notes',
  description:
    'Lists the notes a person wrote about one session, the most recently changed first: id, when written and ' +
    'changed, the text (up to 4 000 characters, fenced as untrusted data) and the ids of the images and videos it ' +
    'embeds (note_media_get describes one). 50 by default, up to 100.',
  risk: 'read',
  phase: 1,
  input: { sessionId: SESSION_REF, limit: limitInput(SHOWN_MAX, SHOWN_DEFAULT) },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.sessionId);
    const body = unwrap<unknown>(await ctx.client.get(`/db/sessions/${seg(s.sessionId)}/notes`));
    const all = records(body)
      .flatMap((raw) => {
        const note = noteOf(raw);
        return note === null ? [] : [note];
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    const shown = all.slice(0, args.limit ?? SHOWN_DEFAULT);
    const source = sessionSource(s.sessionId);
    const ref = refOf(ctx)(s.sessionId);
    const data = {
      id: s.sessionId,
      shortId: shortIdOf(s.sessionId),
      count: all.length,
      shown: shown.length,
      notes: shown.map((n) => {
        const text = fenced(source, 'note', n.text, TEXT_MAX);
        return { id: n.id, createdAt: n.createdAt, updatedAt: n.updatedAt, text: text.value, textTruncated: text.truncated, textLength: text.length, media: mediaIn(n.text) };
      }),
    };
    if (all.length === 0) return { data, summary: `Session ${ref} has no notes.` };
    const more = all.length > shown.length ? ` ${all.length - shown.length} more are not shown.` : '';
    const rows = shown.map((n) => {
      const media = mediaIn(n.text).length;
      return `note ${n.id} · ${isoTime(n.updatedAt)} · ${JSON.stringify(oneLine(n.text, ROW_TEXT))}${media > 0 ? ` · ${plural(media, 'file')} embedded` : ''}`;
    });
    return { data, summary: `Session ${ref} has ${plural(all.length, 'note')}.${more}\n${fence(source, 'notes', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// note_media_get
// ---------------------------------------------------------------------------

/** `640 bytes`, `12.5 KB`, `3.2 MB`. */
function sizeOf(bytes: number): string {
  if (bytes < 1_024) return `${bytes} bytes`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const noteMediaGet = defineTool({
  name: 'note_media_get',
  toolset: 'notes',
  title: 'Describe a note’s image or video',
  description:
    'Describes one image or video embedded in a note: which session owns it, its name, type and size. The file’s ' +
    'bytes are not available through MCP in this version: this description is all AASC gives of it. The file must ' +
    'belong to a session you can see.',
  risk: 'read',
  phase: 1,
  input: { id: MEDIA_ID },
  async run(args, ctx) {
    const answer = await ctx.client.get(`/note-media/${seg(args.id)}/meta`);
    // A build of AASC without this route answers with the app's own page: a 200 that holds no JSON.
    if (answer.ok && (answer.data === null || answer.data === undefined)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC cannot describe note media.', 'Use note_list; it names the media a note embeds.');
    }
    const body = unwrap<unknown>(answer);
    const meta = isRecord(body) ? body : {};
    const owner = str(meta.sessionId) ?? '';
    if (ctx.central.kind !== 'global' && !ctx.scopedSessions().some((s) => s.sessionId === owner)) throw notInScope('media');
    const rawMime = str(meta.mime) ?? '';
    const mime = MIME.test(rawMime) ? rawMime.toLowerCase() : '';
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'other';
    const bytes = whole(meta.bytes);
    const name = str(meta.name);
    const resourceUri = `aasc://notes/media/${args.id}`;
    const data = {
      id: args.id,
      sessionId: owner,
      shortId: shortIdOf(owner),
      name: name === null || name === '' ? null : name,
      mime,
      kind,
      bytes,
      createdAt: whole(meta.createdAt),
      url: `/api/note-media/${args.id}`,
      resourceUri,
    };
    const what = kind === 'image' ? 'an image' : kind === 'video' ? 'a video' : 'a file';
    const lead =
      `Note media ${args.id} is ${what} (${mime === '' ? 'unknown type' : mime}, ${sizeOf(bytes)}) of session ${refOf(ctx)(owner)}. ` +
      'Its bytes are not sent through MCP in this version; this description is all AASC gives of it.';
    return { data, summary: data.name === null ? lead : `${lead}\n${fence('aasc', 'note-media', `name ${JSON.stringify(data.name)}`)}` };
  },
});

export const noteTools: readonly ToolDef[] = [noteList, noteMediaGet, ...noteWriteTools, noteDeleteTool];
