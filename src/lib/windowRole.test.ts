import { describe, it, expect } from 'vitest';
import { POPOUT_KINDS, isPopoutWindow, resolveWindowRole } from './windowRole';

describe('resolveWindowRole', () => {
  it('is the dashboard when the URL asks for nothing special', () => {
    expect(resolveWindowRole('')).toEqual({ role: 'dashboard' });
    expect(resolveWindowRole('?sessionId=abc')).toEqual({ role: 'dashboard' });
  });

  it.each(POPOUT_KINDS)('knows the %s pop-out', (kind) => {
    expect(resolveWindowRole(`?popout=${kind}&sessionId=s1`)).toEqual({ role: 'popout', kind });
  });

  it('keeps the four kinds main.tsx can render', () => {
    expect([...POPOUT_KINDS].sort()).toEqual(['project', 'queue', 'session', 'terminal']);
  });

  it('does not boot the dashboard for a pop-out kind it does not know', () => {
    // An unrecognised kind used to fall through to the dashboard — a second window running its own
    // queue scheduler, which sends every queued prompt twice.
    expect(resolveWindowRole('?popout=timeline')).toEqual({ role: 'unknown-popout', kind: 'timeline' });
  });

  it('treats an empty popout parameter as no pop-out at all', () => {
    expect(resolveWindowRole('?popout=')).toEqual({ role: 'dashboard' });
  });

  it('matches kinds exactly — no case folding, no prefix match', () => {
    expect(resolveWindowRole('?popout=Queue')).toEqual({ role: 'unknown-popout', kind: 'Queue' });
    expect(resolveWindowRole('?popout=queue2')).toEqual({ role: 'unknown-popout', kind: 'queue2' });
  });
});

describe('isPopoutWindow', () => {
  it('is true for every pop-out, known or not', () => {
    expect(isPopoutWindow('?popout=queue&sessionId=s1')).toBe(true);
    expect(isPopoutWindow('?popout=terminal')).toBe(true);
    expect(isPopoutWindow('?popout=something-new')).toBe(true);
  });

  it('is false for the dashboard', () => {
    expect(isPopoutWindow('')).toBe(false);
    expect(isPopoutWindow('?popout=')).toBe(false);
    expect(isPopoutWindow('?sessionId=s1')).toBe(false);
  });

  it('reads the current window when no query is given', () => {
    window.history.pushState({}, '', '/?popout=queue&sessionId=s1');
    try {
      expect(isPopoutWindow()).toBe(true);
    } finally {
      window.history.pushState({}, '', '/');
    }
    expect(isPopoutWindow()).toBe(false);
  });
});
