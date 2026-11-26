import { describe, expect, it } from 'vitest';
import type { Session } from '@/types';
import { contextDetailsView } from './contextDetails';

const session = (runtime: Session['runtime']): Session =>
  ({ sessionId: '1761a9e8-aaaa-bbbb-cccc-000000000000', model: 'claude-opus-5-5', runtime }) as unknown as Session;

const CONTEXT = {
  pct: 26,
  size: 1_000_000,
  tokens: 263_000,
  parts: { input: 1000, cacheWrite: 2700, cacheRead: 259_300, output: 128 },
};

describe('contextDetailsView', () => {
  it('lays out the card the way the screenshot does', () => {
    const view = contextDetailsView(session({ model: 'claude-opus-5-5', effort: 'xhigh', effortAt: 1, context: CONTEXT }), {
      totals: { steps: 165, input: 300_000, cacheWrite: 1_000_000, cacheRead: 39_800_000, output: 284_000 },
      costUsd: 14.0812,
      terminal: { cols: 115, rows: 35 },
    });
    expect(view).toMatchObject({
      effort: 'xhigh',
      steps: '165 steps',
      context: { text: '263k / 1M (26.3%)', free: '737k free', estimated: false, level: 'ok' },
      cost: '$14.08',
      shortId: '1761a9e8',
      terminal: '115×35',
    });
    // One row per scope, input beside output; the hit rates on their own line below.
    expect(view?.tokens).toEqual([
      { label: 'Last reply', input: '263k', detail: 'cached 259k · new 3.7k', output: '128' },
      { label: 'Session', input: '41.1M', detail: 'cached 39.8M', output: '284k' },
    ]);
    expect(view?.cacheHit).toBe('last reply 98.6% · session 96.8%');
  });

  it('leaves out what was not reported instead of showing 0', () => {
    const view = contextDetailsView(session({ model: 'claude-opus-5-5' }), {});
    expect(view).not.toBeNull();
    expect(view?.context).toBeUndefined();
    expect(view?.steps).toBeUndefined();
    expect(view?.cost).toBeUndefined();
    expect(view?.terminal).toBeUndefined();
    expect(view?.tokens).toEqual([]);
    expect(view?.cacheHit).toBeUndefined();
  });

  it('says nothing is free when the size is not known or the window is full', () => {
    const noSize = contextDetailsView(session({ model: 'm', context: { pct: 26 } }), null);
    expect(noSize?.context?.free).toBeUndefined();
    const full = contextDetailsView(session({ model: 'm', context: { ...CONTEXT, tokens: 1_000_000 } }), null);
    expect(full?.context?.free).toBeUndefined();
  });

  it('shows the last reply before the totals arrive', () => {
    const view = contextDetailsView(session({ model: 'claude-opus-5-5', context: CONTEXT }), null);
    expect(view?.tokens.map((r) => r.label)).toEqual(['Last reply']);
    expect(view?.cacheHit).toBe('last reply 98.6%');
  });

  it('marks a % that was worked out from tokens as an estimate', () => {
    const view = contextDetailsView(session({ model: 'claude-opus-5-5', context: { ...CONTEXT, estimated: true } }), null);
    expect(view?.context?.estimated).toBe(true);
  });

  it('says "1 step", not "1 steps"', () => {
    const view = contextDetailsView(session({ model: 'm' }), {
      totals: { steps: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
    });
    expect(view?.steps).toBe('1 step');
  });
});
