/**
 * videoAttach — a video for a prompt, from a phone (Oct 27 2026).
 *
 * A photo rides the message as a data URL; a video is far too big for that (the
 * shared queue syncs as one payload of a few MB). So a picked or recorded video is
 * uploaded to the Mac at once, raw (`POST /api/queue-media`, server/queueMediaRouter.ts),
 * and the message carries the path the Mac saved it under, on its own line under
 * the text: the way a photo's path is typed into the CLI. A sent message and a
 * queued one (fired from any device, later) both work that way, with no change to
 * the queue's shape. The Mac sweeps the file after 24 h, as it does the photos.
 *
 * Claude Code and Codex can't watch a video: they get its path.
 */

/** As the Mac allows (server/queueMediaRouter.ts `MAX_QUEUE_MEDIA_BYTES`). */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** The types the Mac takes (server/queueMediaRouter.ts `QUEUE_MEDIA_TYPES`). */
const ACCEPTED_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']);

/** A type for a picked file the picker left untyped, by its extension. */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
};

/** A picked file's video type (from its extension when the picker gave none), or null when it isn't a video. */
export function videoTypeOf(file: Pick<File, 'name' | 'type'>): string | null {
  if (file.type.startsWith('video/')) return file.type;
  if (file.type !== '') return null;
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[ext] ?? null;
}

/** Picked files as photos and videos, each in the order picked. */
export function splitMediaFiles(files: readonly File[]): { images: File[]; videos: File[] } {
  const images: File[] = [];
  const videos: File[] = [];
  for (const f of files) (videoTypeOf(f) ? videos : images).push(f);
  return { images, videos };
}

export type VideoUploadFailure = 'unsupported' | 'too-large' | 'busy' | 'network' | 'failed';

export type VideoUploadResult =
  | { ok: true; path: string; id: string }
  | { ok: false; reason: VideoUploadFailure; message: string };

const FAILURE_MESSAGES: Readonly<Record<VideoUploadFailure, string>> = {
  unsupported: 'Only MP4, MOV, M4V and WebM videos can be attached.',
  'too-large': `That video is over ${MAX_VIDEO_BYTES / 1024 / 1024} MB. Trim it, or send a shorter one.`,
  busy: 'This phone sent a lot of files just now. Try the video again in a minute.',
  network: 'Couldn’t reach your Mac to send the video. Check the connection and try again.',
  failed: 'Your Mac couldn’t save the video. Try again.',
};

const failure = (reason: VideoUploadFailure): VideoUploadResult => ({ ok: false, reason, message: FAILURE_MESSAGES[reason] });

/** Upload one video to the Mac; never throws. */
export async function uploadVideo(file: File, fetchImpl: typeof fetch = fetch): Promise<VideoUploadResult> {
  const type = videoTypeOf(file);
  if (!type || !ACCEPTED_TYPES.has(type)) return failure('unsupported');
  if (file.size > MAX_VIDEO_BYTES) return failure('too-large');
  let res: Response;
  try {
    res = await fetchImpl('/api/queue-media', { method: 'POST', body: file, headers: { 'Content-Type': type } });
  } catch {
    return failure('network');
  }
  if (res.status === 413) return failure('too-large');
  if (res.status === 415) return failure('unsupported');
  if (res.status === 429) return failure('busy');
  const reply = (await res.json().catch(() => null)) as { path?: unknown; id?: unknown } | null;
  if (!res.ok || typeof reply?.path !== 'string' || typeof reply.id !== 'string') return failure('failed');
  return { ok: true, path: reply.path, id: reply.id };
}

/** The message text with each video's path on its own line under it. */
export function withVideoPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const body = text.replace(/\s+$/, '');
  return body === '' ? paths.join('\n') : `${body}\n${paths.join('\n')}`;
}

/** A clip's length as `m:ss` (or `h:mm:ss`); null when the length isn't known. */
export function formatVideoLength(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
