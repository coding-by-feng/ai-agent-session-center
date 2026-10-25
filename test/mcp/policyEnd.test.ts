// test/mcp/policyEnd.test.ts — P5's ending rail in server/mcp/policy.ts (`assertMayEnd`, Ruling P5-8: interrupt, restart,
// kill and close), in its order, and `ctx.mayEnd` as callContext.ts builds it: the caller's own task does not block an
// end (the person is asked), another central's still does. Pure: nothing here reaches a route, a terminal or a process.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { contextFor, lockedByAnother, neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import { assertMayEnd, SteerRefusal, type SteerContext } from '../../server/mcp/policy.js';
import type { McpDeps } from '../../server/mcp/server.js';
import type { CentralRecord } from '../../server/mcp/types.js';
import { fakeBus, globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { fakeClient, makeCentral, makeRoom, makeSession, NOW } from './toolHarness.js';

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

describe('assertMayEnd', () => {
  it('end refuses itself, another central, an ops shell, a subagent, a floating popup, an external and an SSH card', () => {
    const cases: Array<[Session, string]> = [
      [card('own-card', { central: { centralId: 'c1', kind: 'global', scopeRef: null } }), 'A central never ends itself.'],
      [makeSession('own-terminal', { terminalId: 'term-c1' }), 'A central never ends itself.'],
      [card('other-central', { central: { centralId: 'c2', kind: 'room', scopeRef: 'r1' } }), 'That session is another central: a central never ends one.'],
      [makeSession('ops-77', { terminalId: 'term-ops' }), 'That is a session’s command shell, not an agent.'],
      [card('sub-77', { isSubagent: true }), 'That is a subagent: it belongs to the session that runs it.'],
      [card('popup-77', { isFloating: true }), 'That is a floating AI popup, not a session a central steers.'],
      [card('ext-77', { isExternal: true }), 'AASC did not start that session (an external card): it has no terminal AASC types into.'],
      [card('remote-77', { sshHost: 'build-box', source: 'ssh' }), 'That session runs on another machine (SSH): centrals steer sessions on this Mac only.'],
    ];
    for (const [s, words] of cases) {
      const err = refusal(() => assertMayEnd(central, s, rails()));
      expect(err.code, s.sessionId).toBe('INVALID');
      expect(err.message, s.sessionId).toBe(words);
      expect(err.sessionId).toBe(s.sessionId);
      expect(err.message).not.toContain(s.sessionId);
    }
  });

  it('out of scope comes first, and says nothing more', () => {
    const err = refusal(() => assertMayEnd(central, card('w1', { handsOff: true, isSubagent: true }), rails({ inScope: () => false })));
    expect(err.code).toBe('NOT_IN_SCOPE');
  });

  it('end refuses hands-off, a person in the last 60 s, the person’s Esc hold', () => {
    expect(refusal(() => assertMayEnd(central, card('w1', { handsOff: true }), rails())).code).toBe('HANDS_OFF');

    const typed = rails({ controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 5_000 }) });
    expect(refusal(() => assertMayEnd(central, card('w1'), typed)).code).toBe('HUMAN_ACTIVE');
    // A central's own presence is no person; a person a minute ago no longer counts.
    expect(() => assertMayEnd(central, card('w1'), rails({ controller: () => ({ clientId: 'mcp:c9', lastActivityAt: NOW }) }))).not.toThrow();
    expect(() =>
      assertMayEnd(central, card('w1'), rails({ controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 61_000 }) })),
    ).not.toThrow();

    const held = refusal(() => assertMayEnd(central, card('w1', { userCancelledAt: NOW - 1_000 }), rails()));
    expect(held).toMatchObject({ code: 'HUMAN_ACTIVE', message: 'The person stopped that session with Esc; it waits for them.' });
    // The stamp a central's own Esc caused is not the person's.
    const own = rails({ centralEscAt: () => NOW - 1_200 });
    expect(() => assertMayEnd(central, card('w1', { userCancelledAt: NOW - 1_000 }), own)).not.toThrow();
  });

  it('end refuses a locked session BUSY', () => {
    expect(refusal(() => assertMayEnd(central, card('w1'), rails({ isLocked: () => true }))).code).toBe('BUSY');
  });

  it('end accepts an ended card, and one with no terminal', () => {
    expect(() => assertMayEnd(central, card('w1', { status: 'ended' }), rails())).not.toThrow();
    expect(() => assertMayEnd(central, makeSession('w2', { status: 'ended', terminalId: null }), rails())).not.toThrow();
    expect(() => assertMayEnd(central, card('w3', { status: 'working' }), rails())).not.toThrow();
  });
});

describe('ctx.mayEnd and the lock', () => {
  function world() {
    const registry = createCentralRegistry();
    const caller = registry.mint(globalInput());
    const other = registry.mint(roomInput('r1'));
    const sessions: Session[] = [
      makeSession('card-1', { terminalId: 'term-card', central: { centralId: caller.centralId, kind: 'global', scopeRef: null } }),
      card('mine', { status: 'waiting' }),
      card('theirs', { status: 'waiting' }),
      card('free', { status: 'waiting' }),
    ];
    const t = testDeliver({ sessions: () => sessions });
    for (const s of sessions) t.ledgerDeps.setSession(s);
    const deps: McpDeps = {
      registry,
      client: () => fakeClient(),
      sessions: () => sessions,
      rooms: () => [makeRoom('r1', ['theirs'])],
      events: createEventHub(fakeBus().subscribe),
      now: () => NOW,
      deliver: t.deliver,
    };
    const byId = (id: string) => sessions.find((s) => s.sessionId === id) as Session;
    const ctxOf = (id: string) => contextFor(id, deps, neverAborted);
    const callerCtx = ctxOf(caller.centralId);
    callerCtx.ledger.create({ central: callerCtx.central, session: byId('mine'), task: 'do it' });
    const otherCtx = ctxOf(other.centralId);
    otherCtx.ledger.create({ central: otherCtx.central, session: byId('theirs'), task: 'do it' });
    return { ctx: callerCtx, byId, t, deps };
  }

  it('end refuses another central’s task (BUSY) but not the caller’s own', () => {
    const w = world();

    expect(() => w.ctx.mayEnd(w.byId('mine'))).not.toThrow();
    expect(() => w.ctx.mayEnd(w.byId('free'))).not.toThrow();
    expect(refusal(() => w.ctx.mayEnd(w.byId('theirs'))).code).toBe('BUSY');
    // A steer still counts the caller's own task.
    expect(refusal(() => w.ctx.mayDrive(w.byId('mine'))).code).toBe('BUSY');
  });

  it('lockedByAnother leaves out each own open task, never another central’s', () => {
    const w = world();

    expect(lockedByAnother(w.ctx.ledger, 'mine')).toBe(false);
    expect(lockedByAnother(w.ctx.ledger, 'theirs')).toBe(true);
    expect(lockedByAnother(w.ctx.ledger, 'free')).toBe(false);
  });

  it('a refusal is reported to the call’s audit once, with the session it refused', () => {
    const w = world();
    const refused = vi.fn();
    const ctx = contextFor(w.ctx.central.centralId, w.deps, neverAborted, { refused });

    const err = refusal(() => ctx.mayEnd(w.byId('theirs')));

    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith(err, 'theirs');
  });
});
