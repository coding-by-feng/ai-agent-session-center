import { describe, it, expect } from 'vitest';
import {
  truncateText,
  trimCurrentPrompt,
  pushPrompt,
  toArchivedSession,
  MAX_PROMPT_CHARS,
  MAX_PROMPT_HISTORY_CHARS,
  MAX_PROMPT_HISTORY_ENTRIES,
  MAX_CURRENT_PROMPT_CHARS,
  TRUNCATION_MARKER,
} from '../server/sessionTrim.js';
import type { PromptEntry, Session } from '../src/types/session.js';

const prompt = (text: string, timestamp = 1): PromptEntry => ({ text, timestamp });
const totalChars = (h: PromptEntry[]) => h.reduce((n, p) => n + p.text.length, 0);

describe('truncateText', () => {
  it('leaves text that fits untouched', () => {
    expect(truncateText('hello', 100)).toBe('hello');
    expect(truncateText('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('truncates and marks longer text', () => {
    const out = truncateText('x'.repeat(500), 100);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('tolerates non-string input rather than throwing', () => {
    expect(truncateText(undefined as unknown as string, 10)).toBe(undefined);
  });
});

describe('trimCurrentPrompt', () => {
  it('caps the always-broadcast prompt', () => {
    const out = trimCurrentPrompt('y'.repeat(60_000));
    expect(out.length).toBe(MAX_CURRENT_PROMPT_CHARS + TRUNCATION_MARKER.length);
  });

  it('keeps a normal prompt verbatim', () => {
    expect(trimCurrentPrompt('do the thing')).toBe('do the thing');
  });

  it('still leaves far more than the 60 chars the robot bubble shows', () => {
    expect(MAX_CURRENT_PROMPT_CHARS).toBeGreaterThan(60);
  });
});

describe('pushPrompt', () => {
  it('appends normally when everything fits', () => {
    const h: PromptEntry[] = [];
    pushPrompt(h, prompt('one', 1));
    pushPrompt(h, prompt('two', 2));
    expect(h.map((p) => p.text)).toEqual(['one', 'two']);
  });

  it('preserves non-text fields on the entry', () => {
    const h: PromptEntry[] = [];
    pushPrompt(h, prompt('hi', 1234));
    expect(h[0].timestamp).toBe(1234);
  });

  it('keeps the entry-count cap', () => {
    const h: PromptEntry[] = [];
    for (let i = 0; i < MAX_PROMPT_HISTORY_ENTRIES + 20; i++) pushPrompt(h, prompt(`p${i}`, i));
    expect(h.length).toBe(MAX_PROMPT_HISTORY_ENTRIES);
    // Oldest dropped, newest kept.
    expect(h[h.length - 1].text).toBe(`p${MAX_PROMPT_HISTORY_ENTRIES + 19}`);
  });

  it('truncates a single oversized prompt', () => {
    const h: PromptEntry[] = [];
    pushPrompt(h, prompt('z'.repeat(MAX_PROMPT_CHARS * 4), 1));
    expect(h[0].text.length).toBe(MAX_PROMPT_CHARS + TRUNCATION_MARKER.length);
  });

  it('enforces the total character budget by dropping oldest', () => {
    const h: PromptEntry[] = [];
    // 40 × 16 000 chars = 640 000, far above the budget.
    for (let i = 0; i < 40; i++) pushPrompt(h, prompt('a'.repeat(MAX_PROMPT_CHARS), i));
    expect(totalChars(h)).toBeLessThanOrEqual(MAX_PROMPT_HISTORY_CHARS + TRUNCATION_MARKER.length);
    expect(h.length).toBeLessThan(40);
    expect(h[h.length - 1].timestamp).toBe(39); // newest survived
  });

  it('never drops the newest prompt, even alone over budget', () => {
    const h: PromptEntry[] = [];
    for (let i = 0; i < 30; i++) pushPrompt(h, prompt('b'.repeat(MAX_PROMPT_CHARS), i));
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h[h.length - 1].timestamp).toBe(29);
  });

  it('bounds a pathological paste-heavy history far below the 1 MB seen in the wild', () => {
    const h: PromptEntry[] = [];
    for (let i = 0; i < 50; i++) pushPrompt(h, prompt('c'.repeat(21_000), i));
    // Previously: 50 × 21 000 ≈ 1 050 000 chars.
    expect(totalChars(h)).toBeLessThan(250_000);
  });

  it('mutates in place and returns the same array', () => {
    const h: PromptEntry[] = [];
    expect(pushPrompt(h, prompt('x', 1))).toBe(h);
  });

  // The DB stores prompts at full length; SessionStart replays them through
  // pushPrompt so a restore cannot reintroduce an unbounded history.
  it('bounds a DB restore replayed through it', () => {
    const fromDb = Array.from({ length: 80 }, (_, i) => prompt('d'.repeat(30_000), i));
    const h: PromptEntry[] = [];
    for (const p of fromDb) pushPrompt(h, p);
    expect(h.length).toBeLessThanOrEqual(MAX_PROMPT_HISTORY_ENTRIES);
    expect(totalChars(h)).toBeLessThanOrEqual(MAX_PROMPT_HISTORY_CHARS + TRUNCATION_MARKER.length);
    expect(h[h.length - 1].timestamp).toBe(79); // newest preserved
  });
});

describe('toArchivedSession', () => {
  const session = {
    sessionId: 's1',
    startedAt: 100,
    endedAt: 200,
    promptHistory: [prompt('hello', 1), prompt('world', 2)],
    toolLog: new Array(200).fill({ tool: 'Bash', timestamp: 1 }),
    responseLog: new Array(50).fill({ text: 'x'.repeat(1000), timestamp: 1 }),
    events: new Array(50).fill({ type: 'Stop', timestamp: 1 }),
    toolUsage: { Bash: 200 },
    totalToolCalls: 200,
  } as unknown as Session;

  it('carries exactly the fields the UI reads', () => {
    expect(Object.keys(toArchivedSession(session)).sort())
      .toEqual(['endedAt', 'promptHistory', 'sessionId', 'startedAt']);
  });

  it('preserves the prompt history the previous-session panel renders', () => {
    expect(toArchivedSession(session).promptHistory.map((p) => p.text)).toEqual(['hello', 'world']);
  });

  it('copies the history rather than aliasing it', () => {
    const archived = toArchivedSession(session);
    session.promptHistory.push(prompt('later', 3));
    expect(archived.promptHistory).toHaveLength(2);
  });

  it('drops the write-only logs that dominated the old archive', () => {
    const archived = toArchivedSession(session) as unknown as Record<string, unknown>;
    for (const dead of ['toolLog', 'responseLog', 'events', 'toolUsage', 'totalToolCalls']) {
      expect(archived[dead]).toBeUndefined();
    }
  });

  it('is dramatically smaller than the full session it came from', () => {
    const before = JSON.stringify(session).length;
    const after = JSON.stringify(toArchivedSession(session)).length;
    expect(after).toBeLessThan(before / 10);
  });

  it('truncates oversized prompts inside the archive too', () => {
    const big = { ...session, promptHistory: [prompt('d'.repeat(MAX_PROMPT_CHARS * 3), 1)] } as unknown as Session;
    expect(toArchivedSession(big).promptHistory[0].text.length)
      .toBe(MAX_PROMPT_CHARS + TRUNCATION_MARKER.length);
  });

  it('handles an empty history', () => {
    const empty = { ...session, promptHistory: [] } as unknown as Session;
    expect(toArchivedSession(empty).promptHistory).toEqual([]);
  });
});
