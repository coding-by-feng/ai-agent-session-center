// callAttach.ts — what the person adds on the voice call screen (Nov 24 2026): a camera photo, a
// picked photo or video, a recorded video, any file, or a skill or command to use. A file is
// streamed (never buffered) into the prompt-media folder under the `queue-img-<ms>-<random>.<ext>`
// name, so apiRouter's 24 h sweep clears it like a prompt's photo. The call keeps what was added in
// a pending list until the person's next question takes all of it to the Voice central
// (voiceCall.ts → brainPrompt `added`). Nothing is sent to the central on its own.

import { createWriteStream, mkdirSync, rmSync } from 'fs';
import { basename, join } from 'path';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { QUEUE_IMAGES_DIR } from '../queueImages.js';
import { TooLargeError, byteCap } from '../queueMediaRouter.js';

export type CallAttachmentKind = 'photo' | 'video' | 'file' | 'skill';

export interface CallAttachment {
  id: string;
  kind: CallAttachmentKind;
  /** The file's own name, or a skill's `/name` / `$name`. */
  name: string;
  /** Where the file was saved on this Mac; none for a skill. */
  path?: string;
}

/** The same cap as a prompt's video (queueMediaRouter.ts). */
export const CALL_ATTACH_MAX_BYTES = 100 * 1024 * 1024;

/** What one question can carry, as a Chat message's photos (MAX_PROMPT_IMAGES). */
export const MAX_CALL_ATTACHMENTS = 10;

const NAME_MAX = 120;
const EXT_RE = /^[A-Za-z0-9]{1,10}$/;
const SKILL_RE = /^[/$][A-Za-z0-9][\w:.-]{0,79}$/;

const TYPE_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/zip': 'zip',
};

export function attachmentKind(type: string): Exclude<CallAttachmentKind, 'skill'> {
  const t = type.trim().toLowerCase();
  if (t.startsWith('image/')) return 'photo';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

/** The name's own extension when it is plain letters and digits, else the type's, else `bin`. */
export function extensionFor(name: string, type: string): string {
  const dot = name.lastIndexOf('.');
  const own = dot > 0 ? name.slice(dot + 1) : '';
  if (EXT_RE.test(own)) return own;
  return TYPE_EXT[type.trim().toLowerCase()] ?? 'bin';
}

/** One readable line, no folders, at most NAME_MAX characters. */
export function cleanFileName(name: string): string {
  const flat = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return 'file';
  return flat.length <= NAME_MAX ? flat : `${flat.slice(0, NAME_MAX - 1)}…`;
}

/** A command or skill as the picker gives it (`/name`, `$name`, `/plugin:name`), else null. */
export function skillPick(name: unknown): string | null {
  return typeof name === 'string' && SKILL_RE.test(name) ? name : null;
}

export interface PendingList {
  /** Adds one; null when the list is full. */
  add(item: Omit<CallAttachment, 'id'>): CallAttachment | null;
  remove(id: string): boolean;
  items(): readonly CallAttachment[];
  /** Everything held, handed to a question, and the list emptied. */
  take(): readonly CallAttachment[];
  /** Puts taken items back in front (a question that never reached the central), up to the cap; answers what did not fit. */
  putBack(taken: readonly CallAttachment[]): readonly CallAttachment[];
}

export function createPendingList(max = MAX_CALL_ATTACHMENTS): PendingList {
  let items: CallAttachment[] = [];
  let seq = 0;
  return {
    add(item) {
      if (items.length >= max) return null;
      seq += 1;
      const added = { ...item, id: `att${seq}` };
      items = [...items, added];
      return added;
    },
    remove(id) {
      const next = items.filter((a) => a.id !== id);
      const removed = next.length !== items.length;
      items = next;
      return removed;
    },
    items: () => items,
    take() {
      const taken = items;
      items = [];
      return taken;
    },
    putBack(taken) {
      const all = [...taken, ...items];
      items = all.slice(0, max);
      return all.slice(max);
    },
  };
}

export type SaveResult = { ok: true; path: string; bytes: number } | { ok: false; code: 'too_large' | 'empty' | 'failed' };

/** Streams a body to `<dir>/queue-img-<ms>-<random>.<ext>`; a refused or failed body leaves no file. */
export async function saveCallUpload(
  body: Readable,
  options: { ext: string; dir?: string; maxBytes?: number },
): Promise<SaveResult> {
  const dir = options.dir ?? QUEUE_IMAGES_DIR;
  const ext = EXT_RE.test(options.ext) ? options.ext : 'bin';
  try { mkdirSync(dir, { recursive: true }); } catch { /* the write below says why */ }
  const path = join(dir, `queue-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  const cap = byteCap(options.maxBytes ?? CALL_ATTACH_MAX_BYTES);
  try {
    await pipeline(body, cap, createWriteStream(path, { flags: 'wx' }));
  } catch (err) {
    rmSync(path, { force: true });
    return { ok: false, code: err instanceof TooLargeError ? 'too_large' : 'failed' };
  }
  if (cap.bytes() === 0) {
    rmSync(path, { force: true });
    return { ok: false, code: 'empty' };
  }
  return { ok: true, path, bytes: cap.bytes() };
}
