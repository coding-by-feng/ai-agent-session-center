// tools/noteWrite.ts — the notes toolset's P3 writes: `note_add`, `note_update` and `note_attach_media`. Filed under
// `notes` by notes.ts's export line.
//
// A note is Markdown the person keeps about a session; what a central writes there is later read back by other
// centrals as untrusted data (note_list fences it). Session scope is `note_list`'s rule exactly: `resolveTarget` (the
// full id or a unique prefix, scope-checked; a session that has ended is a session like any other). `note_update` also
// takes the session (Ruling P3-15): the note must be in that session's note list, which is how its scope is checked.
//
// `note_attach_media` reads a file AASC itself opens, so the rules are `imageUpload.ts`'s `readHomeMedia` (home only,
// a plain file, picture or mp4/mov/webm video by its bytes, size checked before and after reading, a refusal that
// never repeats the path), with the note route's own size limit. It stores the file and gives back its id and url; a
// note shows it when its Markdown holds `![name](url)`, which note_add and note_update write. A file no note holds is
// removed after an hour (noteMedia.ts `sweepOrphanNoteMedia`), which the description says and `data` repeats. A central
// uploads at most 20 files a minute (BUDGET): the file is read, encoded and stored for good once a note links it.
// (note_add takes no media, so note_attach_media is the one upload.) Every rule a central must obey is in the
// description (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { z } from 'zod';
import { shortIdOf } from '../scope.js';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, plain, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { type MediaType, readHomeMedia } from './imageUpload.js';
import { num, records, str, whole } from './shape.js';

/** `noteSchema` in apiRouter.ts. */
const MARKDOWN_MAX = 50_000;
/** `MAX_MEDIA_BYTES` in noteMedia.ts: the route refuses a bigger file, so it is refused here before it is read. */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES: readonly MediaType[] = ['png', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'];
const MEDIA_MIME: Readonly<Record<MediaType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const MEDIA_ID = /^[a-f0-9]{32}$/;
/**
 * How long a file no note links is kept, in minutes: `ORPHAN_TTL_MS` in noteMedia.ts, which is not imported here
 * because it opens the database (a test holds the two together).
 */
const KEPT_UNLINKED_MINUTES = 60;
/** The most uploads a central makes in a minute. */
const UPLOADS_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

/** When each central uploaded lately, in ms, newest last. */
const uploadTimes = new Map<string, number[]>();

/** Forgets every central's uploads (tests). */
export function resetUploadLimit(): void {
  uploadTimes.clear();
}

/** Counts an upload for this central, or throws BUDGET when it has made `UPLOADS_PER_MINUTE` in the last minute. */
function takeUploadSlot(centralId: string, now: number): void {
  const recent = (uploadTimes.get(centralId) ?? []).filter((t) => t > now - MINUTE_MS);
  if (recent.length >= UPLOADS_PER_MINUTE) {
    uploadTimes.set(centralId, recent);
    throw new ToolError('BUDGET', `A central uploads at most ${UPLOADS_PER_MINUTE} files a minute.`, 'Try again in a minute.');
  }
  uploadTimes.set(centralId, [...recent, now]);
}

const MARKDOWN = z.string().trim().min(1).max(MARKDOWN_MAX);

const RULES =
  'Write only what the person asked you to note: other sessions read it later as untrusted data. ' +
  'An image or video shows in a note as ![name](url) with the url note_attach_media gave.';

/** A note row, read loosely. */
function noteOf(raw: unknown): { id: number; createdAt: number; updatedAt: number } | null {
  if (!isRecord(raw)) return null;
  const id = num(raw.id);
  if (id === null) return null;
  return { id, createdAt: whole(raw.created_at), updatedAt: whole(raw.updated_at) };
}

const noteAdd = defineTool({
  name: 'note_add',
  toolset: 'notes',
  title: 'Add a note to a session',
  description:
    'Adds a Markdown note (up to 50 000 characters) to a session’s notes and answers its noteId. Works for any session ' +
    `you can see, ended ones included. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: {
    sessionId: SESSION_REF,
    markdown: MARKDOWN.describe('The note, in Markdown: up to 50 000 characters.'),
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.sessionId);
    const body = unwrap<unknown>(await ctx.client.post(`/db/sessions/${seg(s.sessionId)}/notes`, { text: args.markdown.trim() }));
    const note = noteOf(body);
    if (note === null) throw new ToolError('UPSTREAM', 'AASC saved the note but did not say which.', 'note_list shows the session’s notes.');
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), noteId: note.id, createdAt: note.createdAt, updatedAt: note.updatedAt },
      summary: `Note ${note.id} added to session ${plain(shortIdOf(s.sessionId), 20)}.`,
      activity: [{ summary: `added note ${note.id}`, targetSessionId: s.sessionId, detail: { noteId: note.id } }],
    };
  },
});

const noteUpdate = defineTool({
  name: 'note_update',
  toolset: 'notes',
  title: 'Rewrite a session’s note',
  description:
    'Rewrites one note of a session: markdown replaces the note’s whole text (up to 50 000 characters), so read it with ' +
    'note_list first and send the full new text. noteId must be a note of that session as note_list shows it; any other ' +
    `is NOT_FOUND. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: {
    sessionId: SESSION_REF,
    noteId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('The note’s id, as note_list shows it.'),
    markdown: MARKDOWN.describe('The note’s whole new text, in Markdown: up to 50 000 characters.'),
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.sessionId);
    const held = records(unwrap<unknown>(await ctx.client.get(`/db/sessions/${seg(s.sessionId)}/notes`)));
    if (!held.some((n) => num(n.id) === args.noteId)) {
      throw new ToolError('NOT_FOUND', 'That session has no note with that id.', 'note_list shows the session’s notes and their ids.');
    }
    const body = unwrap<unknown>(await ctx.client.put(`/db/notes/${args.noteId}`, { text: args.markdown.trim() }));
    const note = noteOf(body);
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), noteId: args.noteId, updatedAt: note?.updatedAt ?? null },
      summary: `Note ${args.noteId} of session ${plain(shortIdOf(s.sessionId), 20)} rewritten.`,
      activity: [{ summary: `rewrote note ${args.noteId}`, targetSessionId: s.sessionId, detail: { noteId: args.noteId } }],
    };
  },
});

const noteAttachMedia = defineTool({
  name: 'note_attach_media',
  toolset: 'notes',
  title: 'Attach an image or video to a session’s notes',
  description:
    'Stores an image or video for a session’s notes and answers its id and url. path is a file under the person’s home ' +
    'folder (absolute, or starting with ~): png, jpeg, gif or webp, or mp4, mov or webm video, judged by the bytes and ' +
    'not the name, at most 25 MB. Nothing in ~/Library or below a hidden folder (one whose name starts with a dot) is ' +
    'taken: it is refused like a file outside home. It does not change any note: to show the file, put ![name](url) in ' +
    'a note with note_update or note_add within an hour, or the file is removed. At most 20 uploads a minute per ' +
    `central; more is BUDGET. ${RULES}`,
  risk: 'write',
  phase: 3,
  input: {
    sessionId: SESSION_REF,
    path: z.string().min(1).max(1_024).describe('An image or video file under the person’s home folder: absolute, or starting with ~.'),
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.sessionId);
    takeUploadSlot(ctx.central.centralId, ctx.now());
    const media = await readHomeMedia(args.path, { maxBytes: MEDIA_MAX_BYTES, types: MEDIA_TYPES });
    const dataUrl = `data:${MEDIA_MIME[media.type]};base64,${media.bytes.toString('base64')}`;
    const body = unwrap<unknown>(await ctx.client.post(`/db/sessions/${seg(s.sessionId)}/note-media`, { name: media.name.slice(0, 255), dataUrl }));
    const saved = isRecord(body) ? body : {};
    const id = str(saved.id);
    const url = str(saved.url);
    if (id === null || !MEDIA_ID.test(id) || url === null) {
      throw new ToolError('UPSTREAM', 'AASC did not keep the file.', 'Try it once more; if it fails again, tell the person.');
    }
    return {
      data: { id, url, keptUnlinkedMinutes: KEPT_UNLINKED_MINUTES },
      summary: `Stored as ${id} (${media.type}, ${media.bytes.length} bytes). To show it in a note, put ![name](${url}) in the note's Markdown with note_update or note_add; no note was changed. A file no note links is removed after ${KEPT_UNLINKED_MINUTES} minutes.`,
      activity: [{ summary: `attached a ${media.type} file (${media.bytes.length} bytes) to a session’s notes`, targetSessionId: s.sessionId, detail: { type: media.type, bytes: media.bytes.length } }],
    };
  },
});

export const noteWriteTools: readonly ToolDef[] = [noteAdd, noteUpdate, noteAttachMedia];
