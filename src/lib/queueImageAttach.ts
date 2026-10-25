/**
 * queueImageAttach — photos and camera shots for the queue on a phone (AASC-20,
 * feature 61), held to the queue's existing limits.
 *
 * - At most {@link MAX_QUEUE_IMAGES} images per prompt (paste, drop and pick
 *   alike; 10 since Oct 21 2026, was 5), and at most {@link MAX_PROMPT_IMAGES_CHARS}
 *   of them together: the whole queue syncs as one 8 MB payload.
 * - A phone photo is 3–12 MP. Stored as a data URL in the shared queue (which
 *   every device syncs), a few of them would blow past what a queue can carry,
 *   so a photo larger than {@link PHONE_IMAGE_MAX_EDGE} px on its long edge, or
 *   heavier than {@link PHONE_IMAGE_DIRECT_BYTES}, or in a format the agents
 *   can't read (HEIC), is re-encoded as JPEG inside that box. Each image then
 *   stays under {@link PHONE_IMAGE_MAX_CHARS} — the same ~2 MB a shared image
 *   from the share sheet may be (AASC-21). One that can't be brought under it is
 *   refused, never silently dropped.
 *
 * The browser's decoder and canvas are behind {@link ImageCodec}, so the rules
 * are testable without one.
 */
import type { QueueImageAttachment } from '@/stores/queueStore';
import { MAX_PROMPT_IMAGES_CHARS, MAX_QUEUE_IMAGES, tooManyNote, togetherNote } from './queueImageLimits';

// The limits live in queueImageLimits (the desktop's queue uses them too; this module is phone-only).
export { addImagesToPrompt, MAX_PROMPT_IMAGES_CHARS, MAX_QUEUE_IMAGES } from './queueImageLimits';

/**
 * 2000, not 2048 (Oct 21 2026): once one Claude request holds more than 20 images
 * (earlier turns count, and Claude Code resends them) the API rejects any image over
 * 2000 px on either side.
 */
export const PHONE_IMAGE_MAX_EDGE = 2000;

export const PHONE_IMAGE_QUALITY = 0.85;
/** A smaller file of a readable type and size goes in as it is (keeps a PNG screenshot's sharp text). */
export const PHONE_IMAGE_DIRECT_BYTES = 1_500_000;
/** ~2 MB of image as a base64 data URL, as AASC-21's share sheet allows. */
export const PHONE_IMAGE_MAX_CHARS = 2_900_000;

/** Types Claude Code and Codex read as they are. */
const DIRECT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface ImageCodec {
  /** The file as a data URL, unchanged. */
  dataUrl(file: Blob): Promise<string>;
  /** Pixel size, or null when the browser can't decode it. */
  size(file: Blob): Promise<{ width: number; height: number } | null>;
  /** Re-encoded as JPEG fitted inside `maxEdge`, or null when it can't be decoded. */
  shrink(file: Blob, maxEdge: number, quality: number): Promise<string | null>;
}

export type ImageReadResult =
  | { ok: true; image: QueueImageAttachment }
  | { ok: false; reason: 'not-image' | 'unreadable' | 'too-large' };

/** Does this file go in as it is, or through the shrink step? */
export function needsShrink(type: string, bytes: number, size: { width: number; height: number } | null): boolean {
  if (!DIRECT_TYPES.has(type) || bytes > PHONE_IMAGE_DIRECT_BYTES) return true;
  return !!size && Math.max(size.width, size.height) > PHONE_IMAGE_MAX_EDGE;
}

/** Fit `width × height` inside a square of `maxEdge`, never enlarging. */
export function fitInside(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function jpegName(name: string, index: number): string {
  const base = Array.from(name.replace(/\.[^./\\]+$/, ''))
    .filter((c) => c > '\x1f' && c !== '\x7f' && c !== '/' && c !== '\\')
    .join('')
    .trim();
  return `${base || `photo-${index + 1}`}.jpg`;
}

/** One picked or captured file, ready for the queue — or why not. */
export async function readQueueImage(file: File, index: number, codec: ImageCodec = browserCodec): Promise<ImageReadResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'not-image' };
  try {
    const size = DIRECT_TYPES.has(file.type) ? await codec.size(file) : null;
    if (!needsShrink(file.type, file.size, size)) {
      const dataUrl = await codec.dataUrl(file);
      if (dataUrl.length <= PHONE_IMAGE_MAX_CHARS) return { ok: true, image: { name: file.name || `photo-${index + 1}`, dataUrl } };
    }
    for (const quality of [PHONE_IMAGE_QUALITY, 0.7, 0.55]) {
      const dataUrl = await codec.shrink(file, PHONE_IMAGE_MAX_EDGE, quality);
      if (!dataUrl) return { ok: false, reason: 'unreadable' };
      if (dataUrl.length <= PHONE_IMAGE_MAX_CHARS) return { ok: true, image: { name: jpegName(file.name, index), dataUrl } };
    }
    return { ok: false, reason: 'too-large' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}


/**
 * Picked files for a prompt that already holds `current` images (`currentChars` of
 * data URL): as many as fit under the count and the size caps, in order, with a
 * sentence for whatever was left out.
 */
export async function readQueueImages(
  files: readonly File[],
  current: number,
  codec: ImageCodec = browserCodec,
  currentChars = 0,
): Promise<{ images: QueueImageAttachment[]; message: string | null }> {
  const room = Math.max(0, MAX_QUEUE_IMAGES - current);
  const images: QueueImageAttachment[] = [];
  const problems = { 'not-image': 0, unreadable: 0, 'too-large': 0, together: 0 };
  let chars = currentChars;
  for (const [i, file] of files.slice(0, room).entries()) {
    const result = await readQueueImage(file, current + i, codec);
    if (!result.ok) problems[result.reason]++;
    else if (chars + result.image.dataUrl.length > MAX_PROMPT_IMAGES_CHARS) problems.together++;
    else {
      chars += result.image.dataUrl.length;
      images.push(result.image);
    }
  }
  const over = Math.max(0, files.length - room);
  const notes = [
    over > 0 ? tooManyNote(over) : '',
    problems.together > 0 ? togetherNote(problems.together) : '',
    problems['not-image'] > 0 ? 'Only images can be attached here.' : '',
    problems.unreadable > 0 ? 'An image could not be read.' : '',
    problems['too-large'] > 0 ? 'An image is too large even after shrinking.' : '',
  ].filter(Boolean);
  return { images, message: notes.length > 0 ? notes.join(' ') : null };
}

// ── The browser's codec ──────────────────────────────────────────────────────

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const browserCodec: ImageCodec = {
  dataUrl: readAsDataUrl,
  async size(file) {
    if (typeof createImageBitmap !== 'function') return null;
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      return null;
    }
  },
  async shrink(file, maxEdge, quality) {
    if (typeof createImageBitmap !== 'function') return null;
    let bitmap: ImageBitmap;
    try {
      // `from-image` applies the EXIF rotation a phone camera writes.
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return null;
    }
    const { width, height } = fitInside(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    // JPEG has no alpha: a transparent PNG goes on white, not black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', quality);
  },
};
