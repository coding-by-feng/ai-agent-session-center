// test/fileStreamPolicy.test.ts — Nov 5 2026: the phone could not open a 133.8 MB .mp4 ("This file
// is too large to open") because /api/files/read and /api/files/stream capped every streamable type
// at 100 MB, video and audio too, though those are played through Range requests and never loaded
// whole. With no cap on media, the Range header is the only thing bounding a read, so it is parsed
// strictly.
import { describe, expect, it } from 'vitest';
import {
  MAX_STREAMABLE_SIZE,
  isRangeStreamedExt,
  parseByteRange,
  refusesStreamSize,
} from '../server/fileStreamPolicy.js';

const MB = 1024 * 1024;

describe('refusesStreamSize', () => {
  it('lets video and audio of any size through', () => {
    for (const ext of ['.mp4', '.MOV', '.webm', '.ogg', '.mp3', '.wav', '.flac', '.aac', '.m4a']) {
      expect(refusesStreamSize(ext, 133.8 * MB)).toBe(false);
      expect(refusesStreamSize(ext, 4 * 1024 * MB)).toBe(false);
    }
  });

  it('keeps the 100 MB cap for whole-file types: PDF, images, Office', () => {
    for (const ext of ['.pdf', '.png', '.jpg', '.svg', '.docx', '.xlsx']) {
      expect(refusesStreamSize(ext, MAX_STREAMABLE_SIZE)).toBe(false);
      expect(refusesStreamSize(ext, MAX_STREAMABLE_SIZE + 1)).toBe(true);
    }
  });

  it('names the media extensions', () => {
    expect(isRangeStreamedExt('.mp4')).toBe(true);
    expect(isRangeStreamedExt('mp4')).toBe(false); // the routes pass extname(), dot included
    expect(isRangeStreamedExt('.pdf')).toBe(false);
  });
});

describe('parseByteRange', () => {
  const SIZE = 1000;

  it('answers null with no header, a non-bytes unit or several ranges: send the whole file', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
    expect(parseByteRange('', SIZE)).toBeNull();
    expect(parseByteRange('items=0-5', SIZE)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-9', SIZE)).toBeNull();
  });

  it('reads start-end, an open end and the iOS first probe', () => {
    expect(parseByteRange('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=100-', SIZE)).toEqual({ start: 100, end: 999 });
    expect(parseByteRange('bytes=10-20', SIZE)).toEqual({ start: 10, end: 20 });
  });

  it('clamps an end past the file to its last byte', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('reads a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('answers unsatisfiable for a start past the end, a reversed range, junk or an empty file', () => {
    expect(parseByteRange('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=50-10', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=abc-def', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });
});
