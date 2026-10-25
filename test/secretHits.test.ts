// test/secretHits.test.ts — a cloud save's "possible secret" refusal names the file, the lines and the
// masked text (Oct 26 2026), and never the value itself.
import { describe, it, expect } from 'vitest';
import { redactText, REDACT_LINE_MAX } from '../server/resourceMask.js';
import { secretHits, secretRefusal, SECRET_REFUSAL } from '../server/resourcePackages/secretHits.js';

// Built at runtime so no secret-shaped literal sits in the source (push protection).
const KEY = ['sk', 'ant', 'api03', 'Zq8Lm2Np4Rt6Vx9Bc1Df3Gh5'].join('-');

describe('secretHits', () => {
  it('names each changed line with its masked text, never the value', () => {
    const text = ['# Notes', `key is ${KEY}`, 'fine', `export ANTHROPIC_API_KEY=${KEY}`].join('\n');
    const hits = secretHits(text, redactText(text));
    expect(hits).toEqual([
      { line: 2, excerpt: 'key is sk-ant-******' },
      { line: 4, excerpt: 'export ANTHROPIC_API_KEY=******' },
    ]);
    expect(JSON.stringify(hits)).not.toContain(KEY);
  });

  it('cuts a long masked line around its mask', () => {
    const text = `${'word '.repeat(60)}${KEY} ${'tail '.repeat(30)}`;
    const [hit] = secretHits(text, redactText(text));
    expect(hit.excerpt!.length).toBeLessThanOrEqual(122);
    expect(hit.excerpt).toContain('sk-ant-******');
    expect(hit.excerpt!.startsWith('…')).toBe(true);
  });

  it('says a line is too long to check instead of showing it', () => {
    const text = `ok\n${'a '.repeat(REDACT_LINE_MAX)}`;
    expect(secretHits(text, redactText(text))).toEqual([{ line: 2, excerpt: null }]);
  });

  it('gives nothing when the texts no longer line up', () => {
    expect(secretHits('a\nb', 'a')).toEqual([]);
  });
});

describe('secretRefusal', () => {
  it('is the headline, three hits and how many more', () => {
    const text = Array.from({ length: 5 }, (_, i) => `line${i} ${KEY}`).join('\n');
    expect(secretRefusal('SKILL.md', text, redactText(text)).split('\n')).toEqual([
      SECRET_REFUSAL,
      'SKILL.md · line 1: line0 sk-ant-******',
      'SKILL.md · line 2: line1 sk-ant-******',
      'SKILL.md · line 3: line2 sk-ant-******',
      '+2 more',
    ]);
  });

  it('is the headline alone when no line can be named', () => {
    expect(secretRefusal('x.md', 'a\nb', 'a')).toBe(SECRET_REFUSAL);
  });
});
