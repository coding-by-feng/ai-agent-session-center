/**
 * queueImageLimits — how many images one queued prompt may hold, and how much of
 * them together (Oct 21 2026: 10, was 5; ~6 MB, since the whole queue syncs as one
 * 8 MB payload). Shared by the desktop's paste / pick / drop, the queue editor and
 * the phone's photo reader (queueImageAttach, which is phone-only).
 */
import type { QueueImageAttachment } from '@/stores/queueStore';

export const MAX_QUEUE_IMAGES = 10;
/** One prompt's images together, as data URLs: room left in the 8 MB queue payload (Share's 6 MB). */
export const MAX_PROMPT_IMAGES_CHARS = 6_000_000;

export const tooManyNote = (over: number) => `A prompt holds at most ${MAX_QUEUE_IMAGES} images: ${over} not added.`;
export const togetherNote = (n: number) => `These photos are too large together: ${n} not added.`;
const charsOf = (images: readonly QueueImageAttachment[]) => images.reduce((n, i) => n + i.dataUrl.length, 0);

/**
 * Images added to a prompt that holds `prev` (the desktop's paste, pick and drop, and
 * the queue editor): the first ones that fit the count and size caps, and a sentence
 * for what was left out (null when everything fit).
 */
export function addImagesToPrompt(
  prev: readonly QueueImageAttachment[],
  incoming: readonly QueueImageAttachment[],
): { images: QueueImageAttachment[]; message: string | null } {
  const images = [...prev];
  let chars = charsOf(prev);
  let tooMany = 0;
  let together = 0;
  for (const image of incoming) {
    if (images.length >= MAX_QUEUE_IMAGES) tooMany++;
    else if (chars + image.dataUrl.length > MAX_PROMPT_IMAGES_CHARS) together++;
    else {
      chars += image.dataUrl.length;
      images.push(image);
    }
  }
  const notes = [tooMany > 0 ? tooManyNote(tooMany) : '', together > 0 ? togetherNote(together) : ''].filter(Boolean);
  return { images, message: notes.length > 0 ? notes.join(' ') : null };
}
