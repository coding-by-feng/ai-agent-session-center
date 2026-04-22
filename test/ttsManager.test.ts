import { describe, it, expect } from 'vitest';
import { splitByLanguage, synthesize, checkApiKey } from '../server/ttsManager.js';

describe('splitByLanguage', () => {
  it('returns a single en segment for ASCII text', () => {
    const segs = splitByLanguage('Hello world, this is English.');
    expect(segs).toHaveLength(1);
    expect(segs[0].lang).toBe('en');
  });

  it('returns a single zh segment for all-CJK text', () => {
    const segs = splitByLanguage('你好,世界。这是中文测试。');
    expect(segs).toHaveLength(1);
    expect(segs[0].lang).toBe('zh');
  });

  it('splits mixed EN + zh-CN text into multiple segments', () => {
    const segs = splitByLanguage('Hello 你好 World 世界');
    const langs = segs.map((s) => s.lang);
    expect(langs).toContain('en');
    expect(langs).toContain('zh');
  });

  it('keeps punctuation attached to adjacent language segment without creating empty runs', () => {
    const segs = splitByLanguage('Run: npm test. 结果很好!');
    expect(segs.every((s) => s.text.trim().length > 0)).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(splitByLanguage('')).toEqual([]);
  });
});

describe('synthesize (per-user API key guard)', () => {
  it('rejects when apiKey is missing', async () => {
    // @ts-expect-error — deliberately omitting required apiKey to verify runtime guard
    await expect(synthesize({ text: 'hi' })).rejects.toThrow(/api key/i);
  });

  it('rejects when apiKey is an empty string', async () => {
    await expect(synthesize({ apiKey: '   ', text: 'hi' })).rejects.toThrow(/api key/i);
  });
});

describe('checkApiKey', () => {
  it('returns ok=false for empty key without making a network call', async () => {
    const result = await checkApiKey('');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no api key/i);
  });
});
