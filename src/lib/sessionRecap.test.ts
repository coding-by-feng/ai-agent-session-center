// sessionRecap — the small, capped text a session's Summary is made from (Nov 18 2026).
import { describe, it, expect } from 'vitest';
import {
  RECAP_INPUT_MAX, RECAP_LINES, RECAP_PROMPTS, RECAP_PROMPT_CHARS, RECAP_REPLIES, RECAP_REPLY_CHARS,
  cleanRecap, recapInput, recapIsStale,
} from './sessionRecap';
import type { Session } from '@/types';

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 12);
const make = (over: Partial<Session> = {}) => ({
  sessionId: 's1', title: 'Playroom 2', projectName: 'playroom', status: 'idle', promptHistory: [], responseLog: [], ...over,
}) as unknown as Session;

describe('recapInput', () => {
  it('is null when nothing was typed', () => {
    expect(recapInput(make())).toBeNull();
    expect(recapInput(make({ promptHistory: [{ text: '<task-notification>done</task-notification>', timestamp: T }, { text: '   ', timestamp: T }] }))).toBeNull();
  });

  it('lists the prompts oldest first with the latest replies, and says which prompt it reaches', () => {
    const input = recapInput(make({
      promptHistory: [{ text: 'build the image skill', timestamp: T }, { text: '<system-reminder>x</system-reminder>', timestamp: T + 1 }, { text: 'deploy', timestamp: T + DAY }],
      responseLog: [{ text: 'Skill written to .codex/skills.', timestamp: T + 5 }, { text: 'Deployed v3.', timestamp: T + DAY + 5 }],
    }))!;
    expect(input.promptAt).toBe(T + DAY);
    expect(input.text).toContain('Playroom 2');
    expect(input.text.indexOf('build the image skill')).toBeLessThan(input.text.indexOf('deploy'));
    expect(input.text.indexOf('Skill written')).toBeLessThan(input.text.indexOf('Deployed v3.'));
    expect(input.text).not.toContain('system-reminder');
  });

  it('keeps only the newest prompts and replies, each cut short', () => {
    const promptHistory = Array.from({ length: RECAP_PROMPTS + 10 }, (_, i) => ({ text: `prompt-${i} ${'x'.repeat(RECAP_PROMPT_CHARS * 2)}`, timestamp: T + i }));
    const responseLog = Array.from({ length: RECAP_REPLIES + 4 }, (_, i) => ({ text: `reply-${i} ${'y'.repeat(RECAP_REPLY_CHARS * 2)}`, timestamp: T + i }));
    const { text } = recapInput(make({ promptHistory, responseLog }))!;
    expect(text).not.toContain('prompt-9 ');
    expect(text).toContain(`prompt-${RECAP_PROMPTS + 9} `);
    expect(text).not.toContain('reply-3 ');
    expect(text).toContain(`reply-${RECAP_REPLIES + 3} `);
    expect(text).not.toContain('x'.repeat(RECAP_PROMPT_CHARS + 1));
    expect(text).not.toContain('y'.repeat(RECAP_REPLY_CHARS + 1));
    expect(text.length).toBeLessThanOrEqual(RECAP_INPUT_MAX);
  });
});

describe('recapIsStale', () => {
  const session = make({ promptHistory: [{ text: 'a', timestamp: T }, { text: 'b', timestamp: T + 10 }] });

  it('is stale once a prompt newer than the summary was typed', () => {
    expect(recapIsStale(session, { state: 'done', text: 'x', at: T + 20, promptAt: T })).toBe(true);
    expect(recapIsStale(session, { state: 'done', text: 'x', at: T + 20, promptAt: T + 10 })).toBe(false);
  });
});

describe('cleanRecap', () => {
  it('keeps at most the allowed lines, without blank ones or a preamble mark-up', () => {
    const raw = `\n• one\n\n• two\n${Array.from({ length: 10 }, (_, i) => `• extra ${i}`).join('\n')}\n`;
    const lines = cleanRecap(raw).split('\n');
    expect(lines).toHaveLength(RECAP_LINES);
    expect(lines[0]).toBe('• one');
  });

  it('turns - and * bullets into •, and cuts a runaway line', () => {
    expect(cleanRecap('- built it\n* shipped it')).toBe('• built it\n• shipped it');
    expect(cleanRecap(`• ${'z'.repeat(1000)}`).length).toBeLessThan(400);
  });
});
