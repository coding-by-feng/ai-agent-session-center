import { describe, it, expect } from 'vitest';
import {
  brainPrompt, frontInstructions, toSpeakable, SPEAKABLE_MAX, BRAIN_REQUEST_MAX,
} from '../../server/voice/voiceText.js';

describe('frontInstructions', () => {
  it('uses the GPT-Live delegation token and its three policy labels', () => {
    const text = frontInstructions();
    expect(text).toContain('Generate <|SpawnThinking|> when:');
    expect(text).toContain('Do not generate <|SpawnThinking|> when:');
    expect(text).toContain('Backend tools:');
    expect(text).toContain('Do not guess the result while waiting.');
  });

  it('says confirmations happen on the screen, never by voice', () => {
    expect(frontInstructions()).toMatch(/never by voice/i);
  });
});

describe('brainPrompt', () => {
  it('is one line marked as a voice request, quoting what the person said', () => {
    const text = brainPrompt({ request: 'check the AASC project\nplease', context: 'You: hi' });
    expect(text.startsWith('[AASC · voice]')).toBe(true);
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('"check the AASC project please"');
    expect(text).toContain('You: hi');
  });

  it('strips control characters and caps a long request', () => {
    const text = brainPrompt({ request: `a\u0007b\u001b[31m${'x'.repeat(BRAIN_REQUEST_MAX * 2)}`, context: '' });
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text.length).toBeLessThan(BRAIN_REQUEST_MAX + 1200);
  });

  it('asks for a short spoken reply and not to wait on long work', () => {
    const text = brainPrompt({ request: 'start a review', context: '' });
    expect(text).toMatch(/no markdown/i);
    expect(text).toMatch(/do not wait/i);
  });

  it('leaves the context out when there is none', () => {
    expect(brainPrompt({ request: 'hi', context: '  ' })).not.toMatch(/context/i);
  });
});

describe('toSpeakable', () => {
  it('drops code blocks, inline code marks, headings, bullets and emphasis', () => {
    const md = '## Result\n\n- **Two** issues in `auth.ts`\n- see [the PR](https://x.y/1)\n\n```ts\nconst a = 1\n```\nDone.';
    const out = toSpeakable(md);
    expect(out).not.toMatch(/[#*`]|```|\]\(/);
    expect(out).toContain('Two issues in auth.ts');
    expect(out).toContain('the PR');
    expect(out).toContain('code left out');
    expect(out).toContain('Done.');
  });

  it('drops table rows', () => {
    expect(toSpeakable('Summary first.\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Summary first.');
  });

  it('cuts a long answer at a sentence end within the limit', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const out = toSpeakable(long);
    expect(out.length).toBeLessThanOrEqual(SPEAKABLE_MAX);
    expect(out.endsWith('.')).toBe(true);
  });

  it('answers a fixed line for an empty answer', () => {
    expect(toSpeakable('   ')).toMatch(/no answer/i);
  });
});
