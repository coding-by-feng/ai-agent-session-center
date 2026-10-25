// test/mcp/policyCard.test.ts — the two P3 rails in server/mcp/policy.ts: `assertMayEditCard` (a card write: a title,
// a pin, a room move; Ruling P3-7) and `assertMayRelaunch` (a resume or a reconnect; Ruling P3-8), in their order.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { assertMayEditCard, assertMayRelaunch, SteerRefusal, type SteerContext } from '../../server/mcp/policy.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { makeCentral, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const central: CentralRecord = makeCentral('global', null, { centralId: 'c1', terminalId: 'term-c1' });

function rails(over: Partial<SteerContext> = {}): SteerContext {
  return {
    inScope: () => true,
    controller: () => null,
    isLocked: () => false,
    isOpsTerminal: (t) => t === 'term-ops',
    now: () => NOW,
    ...over,
  };
}

const card = (id: string, over: Partial<Session> = {}): Session => makeSession(id, { terminalId: `term-${id}`, ...over });

function refusal(fn: () => void): SteerRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof SteerRefusal) return err;
    throw err;
  }
  throw new Error('a SteerRefusal was expected');
}

describe('assertMayEditCard', () => {
  it('edit refuses another central, itself, an ops shell, a subagent, a floating popup, an external and an SSH card', () => {
    const cases: Session[] = [
      card('other-central', { central: { centralId: 'c2', kind: 'room', scopeRef: 'r1' } }),
      card('own-card', { central: { centralId: 'c1', kind: 'global', scopeRef: null } }),
      makeSession('own-terminal', { terminalId: 'term-c1' }),
      makeSession('ops', { terminalId: 'term-ops' }),
      card('sub', { isSubagent: true }),
      card('popup', { isFloating: true }),
      card('ext', { isExternal: true }),
      card('remote', { sshHost: 'build-box', source: 'ssh' }),
    ];
    for (const s of cases) {
      const err = refusal(() => assertMayEditCard(central, s, rails()));
      expect(err.code, s.sessionId).toBe('INVALID');
      expect(err.sessionId).toBe(s.sessionId);
    }
    // Out of scope comes first, and says nothing more.
    const outside = refusal(() => assertMayEditCard(central, cases[0], rails({ inScope: () => false })));
    expect(outside.code).toBe('NOT_IN_SCOPE');
  });

  it('edit refuses hands-off but not a card a person typed in 5 s ago', () => {
    expect(refusal(() => assertMayEditCard(central, card('w1', { handsOff: true }), rails())).code).toBe('HANDS_OFF');
    const typed = rails({ controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 5_000 }), isLocked: () => true });
    expect(() => assertMayEditCard(central, card('w1'), typed)).not.toThrow();
  });

  it('edit accepts an ended card', () => {
    expect(() => assertMayEditCard(central, card('w1', { status: 'ended', terminalId: null }), rails())).not.toThrow();
  });

  it('edit asSource passes a hands-off card but still refuses another central', () => {
    expect(() => assertMayEditCard(central, card('w1', { handsOff: true }), rails(), { asSource: true })).not.toThrow();
    const other = card('other', { handsOff: true, central: { centralId: 'c2', kind: 'project', scopeRef: '/a' } });
    expect(refusal(() => assertMayEditCard(central, other, rails(), { asSource: true })).code).toBe('INVALID');
    expect(refusal(() => assertMayEditCard(central, card('w1'), rails({ inScope: () => false }), { asSource: true })).code).toBe(
      'NOT_IN_SCOPE',
    );
  });
});

describe('assertMayRelaunch', () => {
  const ended = (over: Partial<Session> = {}): Session => card('w1', { status: 'ended', terminalId: null, ...over });

  it('relaunch refuses a running card', () => {
    const err = refusal(() => assertMayRelaunch(central, card('w1', { status: 'working' }), rails()));
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ code: 'INVALID', message: 'That session is still running.' });
    // The kinds come before it, and scope before them.
    expect(refusal(() => assertMayRelaunch(central, card('s', { isSubagent: true, status: 'ended' }), rails())).message).not.toBe(
      'That session is still running.',
    );
    expect(refusal(() => assertMayRelaunch(central, ended(), rails({ inScope: () => false }))).code).toBe('NOT_IN_SCOPE');
    expect(() => assertMayRelaunch(central, ended(), rails())).not.toThrow();
  });

  it('relaunch applies the 60 s rule and the lock', () => {
    expect(refusal(() => assertMayRelaunch(central, ended({ handsOff: true }), rails())).code).toBe('HANDS_OFF');
    const person = rails({ controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 5_000 }) });
    expect(refusal(() => assertMayRelaunch(central, ended(), person)).code).toBe('HUMAN_ACTIVE');
    const longAgo = rails({ controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 61_000 }) });
    expect(() => assertMayRelaunch(central, ended(), longAgo)).not.toThrow();
    expect(refusal(() => assertMayRelaunch(central, ended(), rails({ isLocked: () => true }))).code).toBe('BUSY');
  });
});
