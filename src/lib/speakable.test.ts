// speakable.test.ts — what the phone's read-aloud button says (AASC-20).
import { describe, it, expect } from 'vitest';
import { toSpeakableText, chunkSpeech } from './speakable';

describe('toSpeakableText', () => {
  it('keeps the words of Markdown and drops its marks', () => {
    const md = '## Result\n\n**Done.** The tests pass in `npm test`.\n\n- first point\n- *second* point\n> quoted';
    expect(toSpeakableText(md)).toBe('Result\n\nDone. The tests pass in npm test.\n\nfirst point\nsecond point\nquoted');
  });

  it('names code, images and links instead of reading them out', () => {
    const md = 'See [the docs](https://x.dev/a) or https://y.dev.\n```ts\nconst a = 1;\n```\n![chart](/api/note-media/abc)';
    expect(toSpeakableText(md)).toBe('See the docs or (link)\n\n(code block)\n\n(image: chart)');
  });

  it('reads a table as rows of words', () => {
    expect(toSpeakableText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a, b\n\n1, 2');
  });

  it('leaves snake_case and file names alone', () => {
    expect(toSpeakableText('edit my_file_name.ts')).toBe('edit my_file_name.ts');
  });
});

describe('chunkSpeech', () => {
  it('keeps short text whole', () => {
    expect(chunkSpeech('Hello there.')).toEqual(['Hello there.']);
    expect(chunkSpeech('   ')).toEqual([]);
  });

  it('splits long text at sentence ends, every piece under the cap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkSpeech(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.every((c) => c.endsWith('.'))).toBe(true);
    expect(chunks.join(' ')).toBe(text);
  });

  it('hard-cuts a run with no boundary', () => {
    const chunks = chunkSpeech('x'.repeat(450), 200);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
  });
});
