// usageModel.test.ts — the phone's usage chip and sheet: this session's context window and
// the account's plan limits, for Claude Code and Codex.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { describeUsage, formatTokens } from './usageModel';

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);
const MIN = 60_000;

function session(extra: Partial<Session> = {}): Session {
  return { sessionId: 's1', status: 'waiting', cliSource: 'claude', model: 'claude-opus-5-5', ...extra } as unknown as Session;
}
const plan = (cli: 'claude' | 'codex', fiveH: number, week: number, extra = {}) => ({
  cli, asOf: NOW - 3 * MIN,
  windows: [
    { minutes: 300, usedPercent: fiveH, resetsAt: NOW + 133 * MIN },
    { minutes: 10080, usedPercent: week, resetsAt: NOW + 3 * 24 * 60 * MIN },
  ],
  ...extra,
});

describe('formatTokens', () => {
  it('reads like a person would say it', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9_500)).toBe('9.5k');
    expect(formatTokens(118_312)).toBe('118k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('describeUsage', () => {
  it('a Claude session: context in % and tokens, the plan by its busiest window', () => {
    const v = describeUsage(session({
      runtime: { context: { pct: 59, size: 200_000, tokens: 118_312 }, contextAt: NOW } as Session['runtime'],
      planUsage: plan('claude', 42, 61),
    }), NOW);
    expect(v.context).toEqual({ pct: 59, pctText: '59%', level: 'ok', tokensText: '118k of 200k tokens' });
    expect(v.chip).toEqual({ context: v.context, planText: 'wk 61%', planHigh: false });
    expect(v.plan?.cliName).toBe('Claude Code');
    expect(v.plan?.rows.map((r) => [r.name, r.percentText, r.resetInText])).toEqual([['5-hour', '42%', '2h 13m'], ['weekly', '61%', 'Oct 23']]);
    expect(v.ariaLabel).toMatch(/^Usage: context 59% used, 118k of 200k tokens\. Claude plan usage: 61% of the weekly limit used/);
  });

  it('a Codex session: its own context and its own plan', () => {
    const v = describeUsage(session({
      cliSource: 'codex', model: 'gpt-6-astra',
      runtime: { context: { pct: 67, size: 258_400, tokens: 172_161 }, contextAt: NOW } as Session['runtime'],
      planUsage: plan('codex', 12, 30, { plan: 'plus' }),
    }), NOW);
    expect(v.context?.tokensText).toBe('172k of 258k tokens');
    expect(v.plan?.cliName).toBe('Codex');
    expect(v.plan?.plan).toBe('plus');
    expect(v.chip?.planText).toBe('wk 30%');
  });

  it('marks a high or reached limit with a glyph, not colour alone', () => {
    expect(describeUsage(session({ planUsage: plan('claude', 91, 40) }), NOW).chip).toEqual({ context: null, planText: '5h 91%', planHigh: true });
    expect(describeUsage(session({ planUsage: plan('claude', 20, 30, { limitReached: true }) }), NOW).chip?.planHigh).toBe(true);
  });

  it('shows no chip when nothing is known, and says why in the sheet', () => {
    const v = describeUsage(session(), NOW);
    expect(v.chip).toBeNull();
    expect(v.context).toBeNull();
    expect(v.plan?.state).toBe('empty');
    expect(v.plan?.reason).toMatch(/Plan usage is read from Claude sessions/);
  });

  it('a window that has since reset is not shown as current', () => {
    const v = describeUsage(session({ planUsage: { cli: 'claude', asOf: NOW - 6 * 60 * MIN, windows: [{ minutes: 300, usedPercent: 80, resetsAt: NOW - MIN }] } }), NOW);
    expect(v.chip).toBeNull();
    expect(v.plan?.state).toBe('expired');
  });

  it('has no plan section for a session of no CLI (a shell)', () => {
    expect(describeUsage(session({ cliSource: undefined, model: undefined, startupCommand: 'zsh' } as Partial<Session>), NOW).plan).toBeNull();
  });
});
