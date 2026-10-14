/**
 * cameraPhoto — a phone camera's photo, made fit for a note (AASC-20).
 *
 * A 12-megapixel shot is 3–5 MB and travels as base64 (a third more) to the
 * note-media route, from a phone, often on mobile data. Scaled to 2048px on its
 * long edge as a JPEG it is a few hundred KB and still sharp on any screen the
 * note is read on. Decoding also turns an iPhone's HEIC into a JPEG, which the
 * server's image allowlist accepts. Anything that can't be decoded here is sent
 * as it came, and the server decides.
 */

export const PHOTO_MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;

/** The size `width`×`height` scaled down (never up) to fit `maxEdge`. */
export function fitWithin(width: number, height: number, maxEdge: number = PHOTO_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Types the server stores as they are (see server/noteMedia.ts). */
const KEEP_AS_IS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function preparePhoto(file: File, maxEdge: number = PHOTO_MAX_EDGE): Promise<File> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    if (size.width === bitmap.width && size.height === bitmap.height && KEEP_AS_IS.has(file.type)) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
