// imageMetadata.ts — remove location and other metadata from a shared image (AASC-21 M5).
//
// A photo shared from the camera roll carries GPS coordinates in its Exif block.
// The shell strips metadata itself before anything leaves the phone, so the
// guarantee doesn't depend on each platform's share extension:
//   JPEG  drop APP1 (Exif, XMP) and APP13 (IPTC) segments
//   PNG   drop eXIf, tEXt, zTXt, iTXt and tIME chunks
//   WebP  drop EXIF and XMP chunks (and clear their flags in VP8X)
//   GIF   carries no location metadata; returned unchanged
// A file that doesn't parse as its claimed type is refused (null), never sent half-cleaned.

export type StrippableType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const JPEG_DROP = new Set([0xe1, 0xed]); // APP1 (Exif/XMP), APP13 (IPTC)

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xda) {
      // Start of scan: the compressed image follows to the end; copy it all.
      for (let j = i; j < b.length; j++) out.push(b[j]);
      return Uint8Array.from(out);
    }
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (!JPEG_DROP.has(marker)) for (let j = i; j < i + 2 + len; j++) out.push(b[j]);
    i += 2 + len;
  }
  return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, k) => b[k] !== v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return concat(parts);
  }
  return null;
}

function stripWebp(b: Uint8Array): Uint8Array | null {
  const tag = (k: number) => String.fromCharCode(b[k], b[k + 1], b[k + 2], b[k + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = tag(i);
    const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | ((b[i + 7] << 24) >>> 0);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) return null;
    if (type === 'EXIF' || type === 'XMP ') {
      i = end;
      continue;
    }
    const chunk = Uint8Array.from(b.subarray(i, Math.min(end, b.length)));
    if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
    parts.push(chunk);
    i = end;
  }
  const body = concat(parts);
  const size = body.length + 4;
  const header = Uint8Array.from([0x52, 0x49, 0x46, 0x46, size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, 0x57, 0x45, 0x42, 0x50]);
  return concat([header, body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The image without its metadata, or null when it isn't a well-formed image of that type. */
export function stripImageMetadata(bytes: Uint8Array, type: StrippableType): Uint8Array | null {
  switch (type) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    case 'image/gif':
      return bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF' ? bytes : null;
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let k = 0; k < bytes.length; k += CHUNK) bin += String.fromCharCode(...bytes.subarray(k, k + CHUNK));
  return btoa(bin);
}
