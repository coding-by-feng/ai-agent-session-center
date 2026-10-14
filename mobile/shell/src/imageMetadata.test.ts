// imageMetadata.test.ts — AASC-21 M5: no location (or other metadata) leaves the phone in a shared image.
import { describe, it, expect } from 'vitest';
import { stripImageMetadata, base64ToBytes, bytesToBase64 } from './imageMetadata';

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const has = (bytes: Uint8Array, s: string) => new TextDecoder('latin1').decode(bytes).includes(s);

/** A JPEG: SOI, APP0 (JFIF), APP1 (Exif with "GPS"), APP13 (IPTC), DQT, SOS + data, EOI. */
function jpeg(): Uint8Array {
  const seg = (marker: number, payload: number[]) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, enc('JFIF\0')),
    ...seg(0xe1, enc('Exif\0\0GPSLatitude 51.5')),
    ...seg(0xed, enc('Photoshop 3.0 location')),
    ...seg(0xdb, [0, 1, 2, 3]),
    0xff, 0xda, 0, 4, 1, 2, 0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [(len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...enc(type), ...data, 0, 0, 0, 0];
}
function png(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', new Array(13).fill(1)),
    ...pngChunk('eXIf', enc('GPSLatitude')),
    ...pngChunk('tEXt', enc('Location\0home')),
    ...pngChunk('IDAT', [9, 9, 9]),
    ...pngChunk('IEND', []),
  ]);
}

function webpChunk(type: string, data: number[]): number[] {
  const len = data.length;
  const padded = len % 2 ? [...data, 0] : data;
  return [...enc(type), len & 255, (len >> 8) & 255, (len >> 16) & 255, (len >>> 24) & 255, ...padded];
}
function webp(): Uint8Array {
  const body = [
    ...enc('WEBP'),
    ...webpChunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...webpChunk('VP8 ', [1, 2, 3, 4]),
    ...webpChunk('EXIF', enc('GPSLatitude')),
    ...webpChunk('XMP ', enc('<x:location/>')),
  ];
  const size = body.length;
  return Uint8Array.from([...enc('RIFF'), size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255, ...body]);
}

describe('stripImageMetadata', () => {
  it('drops a JPEG’s Exif and IPTC segments and keeps the image data', () => {
    const out = stripImageMetadata(jpeg(), 'image/jpeg')!;
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'location')).toBe(false);
    expect(has(out, 'JFIF')).toBe(true);
    expect(Array.from(out.slice(-5))).toEqual([0x11, 0x22, 0x33, 0xff, 0xd9]);
  });

  it('drops a PNG’s eXIf and text chunks and keeps IHDR, IDAT and IEND', () => {
    const out = stripImageMetadata(png(), 'image/png')!;
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'Location')).toBe(false);
    for (const chunk of ['IHDR', 'IDAT', 'IEND']) expect(has(out, chunk)).toBe(true);
  });

  it('drops a WebP’s EXIF and XMP chunks, clears their flags and fixes the RIFF size', () => {
    const out = stripImageMetadata(webp(), 'image/webp')!;
    expect(has(out, 'GPS')).toBe(false);
    expect(has(out, 'location')).toBe(false);
    expect(has(out, 'VP8 ')).toBe(true);
    const size = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(size).toBe(out.length - 8);
    const vp8x = new TextDecoder('latin1').decode(out).indexOf('VP8X');
    expect(out[vp8x + 8] & 0x0c).toBe(0);
  });

  it('refuses a file that isn’t what it claims to be', () => {
    expect(stripImageMetadata(png(), 'image/jpeg')).toBeNull();
    expect(stripImageMetadata(jpeg(), 'image/png')).toBeNull();
    expect(stripImageMetadata(Uint8Array.from([1, 2, 3]), 'image/webp')).toBeNull();
    expect(stripImageMetadata(jpeg().slice(0, 10), 'image/jpeg')).toBeNull();
  });

  it('round-trips base64', () => {
    const bytes = png();
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

