import { describe, it, expect } from 'vitest';
import { resolveContextDisplay, resolveRuntimeDisplay } from './sessionRuntime';
import type { Session } from '@/types';

const session = (p: Partial<Session> = {}): Session =>
  ({ sessionId: 's', model: 'claude-opus-5-5', cliSource: 'claude', ...p }) as unknown as Session;

describe('resolveRuntimeDisplay', () => {
  it('shows the live model and effort the CLI reported', () => {
    expect(resolveRuntimeDisplay(session({
      effortLevel: 'high',
      runtime: { model: 'Haiku 4.5', modelAt: 2, effort: 'medium', effortAt: 2 },
    }))).toEqual({ model: 'Haiku 4.5', effort: 'medium', live: true, effortLive: true });
  });

  it('before any report, falls back to the launch model and effort — marked as such', () => {
    expect(resolveRuntimeDisplay(session({ effortLevel: 'xhigh' })))
      .toEqual({ model: 'Opus 5.5', effort: 'xhigh', live: false, effortLive: false });
  });

  it('REGRESSION GUARD: an effort the CLI made unknown (a model switch) never falls back to the launch value', () => {
    expect(resolveRuntimeDisplay(session({
      effortLevel: 'max',
      runtime: { model: 'Haiku 4.5', modelAt: 3, effortAt: 3 },
    }))).toEqual({ model: 'Haiku 4.5', effort: undefined, live: true, effortLive: true });
  });

  it('nothing for a Codex session or a session with no model at all', () => {
    expect(resolveRuntimeDisplay(session({ cliSource: 'codex', model: 'gpt-5-codex' }))).toBeNull();
    expect(resolveRuntimeDisplay(session({ model: '' }))).toBeNull();
  });
});

describe('resolveContextDisplay', () => {
  const withCtx = (context: unknown, p: Partial<Session> = {}) =>
    session({ runtime: { model: 'Opus 5.5', modelAt: 1, context, contextAt: 1 } as Session['runtime'], ...p });

  it('shows the reported % with its band: under 70 ok, 70-89 warn, 90+ high', () => {
    expect(resolveContextDisplay(withCtx({ pct: 42, size: 200000, tokens: 84312 })))
      .toEqual({ pct: 42, level: 'ok', size: 200000, tokens: 84312 });
    expect(resolveContextDisplay(withCtx({ pct: 69 }))?.level).toBe('ok');
    expect(resolveContextDisplay(withCtx({ pct: 70 }))?.level).toBe('warn');
    expect(resolveContextDisplay(withCtx({ pct: 89 }))?.level).toBe('warn');
    expect(resolveContextDisplay(withCtx({ pct: 90 }))?.level).toBe('high');
  });

  it('nothing (never 0%) until the CLI has reported it', () => {
    expect(resolveContextDisplay(session())).toBeNull();
    expect(resolveContextDisplay(session({ runtime: { model: 'Opus 5.5', modelAt: 1, contextAt: 2 } }))).toBeNull();
  });

  it('Codex too, once its rollout has reported it (Oct 20 2026)', () => {
    expect(resolveContextDisplay(withCtx({ pct: 67, size: 258400, tokens: 172161 }, { cliSource: 'codex' })))
      .toEqual({ pct: 67, size: 258400, tokens: 172161, level: 'ok' });
  });
});
