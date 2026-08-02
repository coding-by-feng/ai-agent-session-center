import { describe, it, expect } from 'vitest';
import {
  insertAtCaret,
  isImageSrc,
  isNoteMediaSrc,
  isVideoSrc,
  mediaFilesFrom,
  mediaMarkdown,
  referencedMediaIds,
} from './noteMedia';

const ID = 'a'.repeat(32);

describe('source classification', () => {
  it('detects video by extension — Markdown has no video syntax to key off', () => {
    for (const src of ['/x/a.mp4', 'b.webm', 'c.MOV', 'd.m4v?t=3', 'e.ogv#t=1']) {
      expect(isVideoSrc(src)).toBe(true);
    }
    for (const src of ['a.png', 'b.jpg', '/api/note-media/' + ID, 'mp4.png']) {
      expect(isVideoSrc(src)).toBe(false);
    }
  });

  it('detects images by extension', () => {
    expect(isImageSrc('shot.PNG')).toBe(true);
    expect(isImageSrc('a.jpeg')).toBe(true);
    expect(isImageSrc('a.mp4')).toBe(false);
  });

  it('recognises our own media URLs and nothing else', () => {
    expect(isNoteMediaSrc(`/api/note-media/${ID}`)).toBe(true);
    expect(isNoteMediaSrc('/api/note-media/short')).toBe(false);
    expect(isNoteMediaSrc(`https://evil.test/api/note-media/${ID}`)).toBe(false);
  });
});

describe('mediaMarkdown', () => {
  it('emits image syntax for any media — video rides the same form', () => {
    expect(mediaMarkdown('demo.mp4', '/api/note-media/x')).toBe('![demo.mp4](/api/note-media/x)');
  });

  it('strips brackets that would break the alt text', () => {
    expect(mediaMarkdown('a[1].png', '/u')).toBe('![a1.png](/u)');
  });

  it('falls back to a generic alt when the name is empty', () => {
    expect(mediaMarkdown('   ', '/u')).toBe('![attachment](/u)');
  });
});

describe('insertAtCaret', () => {
  it('inserts at the caret, not at the end', () => {
    const out = insertAtCaret('start\nend', 5, 'X');
    expect(out.text).toBe('start\nX\nend');
  });

  it('puts the snippet on its own line', () => {
    expect(insertAtCaret('abc', 3, 'X').text).toBe('abc\nX');
    expect(insertAtCaret('', 0, 'X').text).toBe('X');
  });

  it('does not double up existing newlines', () => {
    expect(insertAtCaret('abc\n', 4, 'X').text).toBe('abc\nX');
  });

  it('returns a caret that lands after the snippet so pastes stack', () => {
    const first = insertAtCaret('', 0, '![a](/1)');
    const second = insertAtCaret(first.text, first.caret, '![b](/2)');
    expect(second.text).toBe('![a](/1)\n![b](/2)');
  });

  it('clamps an out-of-range caret instead of corrupting the text', () => {
    expect(insertAtCaret('abc', 99, 'X').text).toBe('abc\nX');
    expect(insertAtCaret('abc', -5, 'X').text).toBe('X\nabc');
  });
});

describe('referencedMediaIds', () => {
  it('finds every embedded id once', () => {
    const b = 'b'.repeat(32);
    const text = `![1](/api/note-media/${ID}) and ![2](/api/note-media/${b}) and again ${ID}`;
    expect(referencedMediaIds(text).sort()).toEqual([ID, b].sort());
  });

  it('returns nothing for plain text', () => {
    expect(referencedMediaIds('just a note')).toEqual([]);
  });
});

describe('mediaFilesFrom', () => {
  const file = (name: string, type: string) => new File(['x'], name, { type });

  it('keeps images and video, drops everything else', () => {
    const files = [file('a.png', 'image/png'), file('b.mp4', 'video/mp4'), file('c.pdf', 'application/pdf')];
    expect(mediaFilesFrom(files).map((f) => f.name)).toEqual(['a.png', 'b.mp4']);
  });

  it('tolerates a null/empty list — a text-only paste must not throw', () => {
    expect(mediaFilesFrom(null)).toEqual([]);
    expect(mediaFilesFrom([])).toEqual([]);
  });
});
