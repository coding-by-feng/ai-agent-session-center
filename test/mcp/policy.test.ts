// test/mcp/policy.test.ts — who a central may steer (server/mcp/policy.ts): the refusals in their order
// (NOT_IN_SCOPE, INVALID, HANDS_OFF, HUMAN_ACTIVE, BUSY), the 60-second rule, fan-out and shell lines; and the one
// exception, a global central handing a task down to a room or project central (Ruling P4-8, `assertMayHandOff`).
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import {
  assertFanOut,
  assertMayHandOff,
  assertMaySteer,
  assertNotShellLine,
  HUMAN_ACTIVE_MS,
  MAX_FAN_OUT,
  SteerRefusal,
  type SteerContext,
} from '../../server/mcp/policy.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { makeCentral, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** A worker the global central may steer: local, idle, with a terminal, nobody near it. */
const worker = (over: Partial<Session> = {}): Session =>
  makeSession('w1', { terminalId: 'term-w1', status: 'waiting', ...over });

function steerCtx(over: Partial<SteerContext> = {}): SteerContext {
  return {
    inScope: () => true,
    controller: () => null,
    isLocked: () => false,
    isOpsTerminal: () => false,
    now: () => NOW,
    ...over,
  };
}

/** The refusal `assertMaySteer` throws (the test fails when it lets the session through). */
function refusal(central: CentralRecord, session: Session, ctx: SteerContext): SteerRefusal {
  try {
    assertMaySteer(central, session, ctx);
  } catch (err) {
    if (err instanceof SteerRefusal) return err;
    throw err;
  }
  throw new Error('assertMaySteer let the session through');
}

const central = makeCentral();

describe('assertMaySteer', () => {
  it('lets a local, idle session with a terminal through', () => {
    expect(() => assertMaySteer(central, worker(), steerCtx())).not.toThrow();
  });

  describe('refuses in order: scope, kind, hands-off, a person, the lock', () => {
    // A session that fails every rule; each step below drops the first failing one.
    const everything = (): { session: Session; ctx: SteerContext } => ({
      session: worker({ isSubagent: true, handsOff: true }),
      ctx: steerCtx({
        inScope: () => false,
        controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 1_000 }),
        isLocked: () => true,
      }),
    });

    it('NOT_IN_SCOPE first', () => {
      const { session, ctx } = everything();
      expect(refusal(central, session, ctx).code).toBe('NOT_IN_SCOPE');
    });

    it('then INVALID', () => {
      const { session, ctx } = everything();
      expect(refusal(central, session, { ...ctx, inScope: () => true }).code).toBe('INVALID');
    });

    it('then HANDS_OFF', () => {
      const { session, ctx } = everything();
      expect(refusal(central, { ...session, isSubagent: false }, { ...ctx, inScope: () => true }).code).toBe(
        'HANDS_OFF',
      );
    });

    it('then HUMAN_ACTIVE', () => {
      const { session, ctx } = everything();
      const plain = { ...session, isSubagent: false, handsOff: false };
      expect(refusal(central, plain, { ...ctx, inScope: () => true }).code).toBe('HUMAN_ACTIVE');
    });

    it('then BUSY', () => {
      const { session, ctx } = everything();
      const plain = { ...session, isSubagent: false, handsOff: false };
      expect(refusal(central, plain, { ...ctx, inScope: () => true, controller: () => null }).code).toBe('BUSY');
    });
  });

  describe('INVALID: the sessions a central never steers', () => {
    const cases: Array<[string, Session, Partial<SteerContext>?]> = [
      ['itself, by its marker', worker({ central: { centralId: central.centralId, kind: 'global', scopeRef: null } })],
      ['itself, by its terminal', worker({ terminalId: central.terminalId })],
      ['another central', worker({ central: { centralId: 'central-2', kind: 'room', scopeRef: 'r1' } })],
      ['an ops shell', worker({ terminalId: 'term-ops' }), { isOpsTerminal: (t) => t === 'term-ops' }],
      ['a subagent', worker({ isSubagent: true })],
      ['a floating fork', worker({ isFloating: true })],
      ['an external card', worker({ isExternal: true })],
      ['an SSH session (sshHost)', worker({ sshHost: 'build-box' })],
      ['an SSH session (sshConfig)', worker({ sshConfig: { host: 'build-box' } as Session['sshConfig'] })],
      ['a session with no terminal', worker({ terminalId: null })],
      ['an ended session', worker({ status: 'ended' })],
    ];

    it.each(cases)('%s', (_name, session, over) => {
      const err = refusal(central, session, steerCtx(over));
      expect(err.code).toBe('INVALID');
      expect(err.hint).toBeTruthy();
    });

    it('says something different for each kind', () => {
      const messages = cases.map(([, session, over]) => refusal(central, session, steerCtx(over)).message);
      // The two "itself" cases and the two SSH cases share their words.
      expect(new Set(messages).size).toBe(cases.length - 2);
    });
  });

  it('refuses a hands-off session with HANDS_OFF', () => {
    const err = refusal(central, worker({ handsOff: true }), steerCtx());
    expect(err).toMatchObject({ code: 'HANDS_OFF' });
  });

  describe('the 60-second rule', () => {
    const drivenBy = (clientId: string, agoMs: number) =>
      steerCtx({ controller: () => ({ clientId, lastActivityAt: NOW - agoMs }) });

    it('refuses while a person typed in the session less than 60 s ago', () => {
      const err = refusal(central, worker(), drivenBy('desktop-1', 59_000));
      expect(err.code).toBe('HUMAN_ACTIVE');
      expect(err.hint).toContain('1 s');
    });

    it('an mcp: driver does not trip the 60 s rule', () => {
      expect(() => assertMaySteer(central, worker(), drivenBy('mcp:central-2', 1_000))).not.toThrow();
    });

    it('a human driver 61 s ago does not trip it', () => {
      expect(() => assertMaySteer(central, worker(), drivenBy('phone-1', 61_000))).not.toThrow();
    });

    it('is exactly 60 s long', () => {
      expect(HUMAN_ACTIVE_MS).toBe(60_000);
      expect(() => assertMaySteer(central, worker(), drivenBy('phone-1', 60_000))).not.toThrow();
      expect(refusal(central, worker(), drivenBy('phone-1', 59_999)).code).toBe('HUMAN_ACTIVE');
    });

    it('asks the controller about the session it was given', () => {
      const controller = vi.fn(() => null);
      assertMaySteer(central, worker(), steerCtx({ controller }));
      expect(controller).toHaveBeenCalledWith('w1');
    });
  });

  it('refuses a session holding a running task with BUSY', () => {
    const isLocked = vi.fn((id: string) => id === 'w1');
    expect(refusal(central, worker(), steerCtx({ isLocked })).code).toBe('BUSY');
    expect(isLocked).toHaveBeenCalledWith('w1');
  });

  it('carries the refused session id for the activity log, and never names it in its words', () => {
    const session = worker({ sessionId: 'secret-looking-id-123', handsOff: true });
    const err = refusal(central, session, steerCtx());
    expect(err).toBeInstanceOf(ToolError);
    expect(err.sessionId).toBe('secret-looking-id-123');
    expect(`${err.message} ${err.hint}`).not.toContain('secret-looking-id-123');
  });

  it('never changes the session it was given', () => {
    const session = worker({ handsOff: true });
    const before = JSON.stringify(session);
    refusal(central, session, steerCtx());
    expect(JSON.stringify(session)).toBe(before);
  });
});

describe('assertMayHandOff (Ruling P4-8)', () => {
  const global = makeCentral('global', null, { centralId: 'central-g', terminalId: 'term-g' });
  const roomChild = makeCentral('room', 'r1', { centralId: 'central-r', terminalId: 'term-r' });
  const projectChild = makeCentral('project', '/a/proj', { centralId: 'central-p', terminalId: 'term-p' });
  /** A child central's own card: a central marker, its terminal, waiting. */
  const cardOf = (child: CentralRecord, over: Partial<Session> = {}): Session =>
    makeSession(`card-${child.centralId}`, {
      terminalId: child.terminalId,
      status: 'waiting',
      central: { centralId: child.centralId, kind: child.kind, scopeRef: child.scopeRef },
      ...over,
    });
  const handOffRefusal = (caller: CentralRecord, child: CentralRecord, session: Session, ctx: SteerContext): SteerRefusal => {
    try {
      assertMayHandOff(caller, child, session, ctx);
    } catch (err) {
      if (err instanceof SteerRefusal) return err;
      throw err;
    }
    throw new Error('assertMayHandOff let the handoff through');
  };

  it('global may hand off to a room central', () => {
    // A central's card is "another central" to assertMaySteer; the handoff is the one exception.
    expect(refusal(global, cardOf(roomChild), steerCtx()).code).toBe('INVALID');
    expect(() => assertMayHandOff(global, roomChild, cardOf(roomChild), steerCtx())).not.toThrow();
    expect(() => assertMayHandOff(global, projectChild, cardOf(projectChild), steerCtx())).not.toThrow();
  });

  it('room or project central may not hand off', () => {
    const cases: Array<[CentralRecord, CentralRecord]> = [
      [roomChild, projectChild],
      [projectChild, roomChild],
      [global, makeCentral('global', null, { centralId: 'central-g2', terminalId: 'term-g2' })],
    ];
    for (const [caller, child] of cases) {
      const err = handOffRefusal(caller, child, cardOf(child), steerCtx());
      expect(err.code, `${caller.kind} → ${child.kind}`).toBe('INVALID');
      expect(err.sessionId).toBe(`card-${child.centralId}`);
    }
  });

  it('hands down only to the child central’s own card, live, on this Mac, with a terminal', () => {
    const notTheCard = [
      makeSession('w1', { terminalId: 'term-w1', status: 'waiting' }),
      cardOf(projectChild),
      cardOf(roomChild, { status: 'ended' }),
      cardOf(roomChild, { terminalId: null, central: { centralId: roomChild.centralId, kind: 'room', scopeRef: 'r1' } }),
      cardOf(roomChild, { sshHost: 'build-box' }),
    ];
    for (const s of notTheCard) expect(handOffRefusal(global, roomChild, s, steerCtx()).code, s.sessionId).toBe('INVALID');
  });

  it('handoff respects hands-off, the 60 s rule and the lock', () => {
    const card = cardOf(roomChild);
    const person = { clientId: 'desktop-1', lastActivityAt: NOW - 10_000 };

    expect(handOffRefusal(global, roomChild, { ...card, handsOff: true }, steerCtx()).code).toBe('HANDS_OFF');
    const recent = handOffRefusal(global, roomChild, card, steerCtx({ controller: () => person }));
    expect(recent.code).toBe('HUMAN_ACTIVE');
    expect(recent.hint).toMatch(/50 s/);
    const stale = { clientId: 'desktop-1', lastActivityAt: NOW - HUMAN_ACTIVE_MS };
    expect(() => assertMayHandOff(global, roomChild, card, steerCtx({ controller: () => stale }))).not.toThrow();
    // The person's Esc hold (Ruling 47), unless the stamp is the one a central's own Esc caused.
    const stopped = { ...card, userCancelledAt: NOW - 1_000 };
    expect(handOffRefusal(global, roomChild, stopped, steerCtx()).code).toBe('HUMAN_ACTIVE');
    expect(() => assertMayHandOff(global, roomChild, stopped, steerCtx({ centralEscAt: () => NOW - 2_000 }))).not.toThrow();
    expect(handOffRefusal(global, roomChild, card, steerCtx({ isLocked: () => true })).code).toBe('BUSY');
    // In assertMaySteer's order: hands-off before a person, a person before the lock.
    const all = steerCtx({ controller: () => person, isLocked: () => true });
    expect(handOffRefusal(global, roomChild, { ...card, handsOff: true }, all).code).toBe('HANDS_OFF');
    expect(handOffRefusal(global, roomChild, card, all).code).toBe('HUMAN_ACTIVE');
  });
});

describe('assertFanOut', () => {
  it('takes 1 to 8 distinct sessions', () => {
    expect(MAX_FAN_OUT).toBe(8);
    expect(() => assertFanOut(['a'])).not.toThrow();
    expect(() => assertFanOut(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).not.toThrow();
  });

  it('refuses a fan-out of 9', () => {
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(() => assertFanOut(nine)).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('refuses no target at all', () => {
    expect(() => assertFanOut([])).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('refuses duplicate targets, spaces around them or not', () => {
    expect(() => assertFanOut(['abc123', 'def456', 'abc123'])).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => assertFanOut(['abc123', ' abc123 '])).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('never repeats a target in its words', () => {
    try {
      assertFanOut(['steal-the-keys', 'steal-the-keys']);
    } catch (err) {
      expect(String((err as ToolError).message) + String((err as ToolError).hint)).not.toContain('steal');
      return;
    }
    throw new Error('expected a refusal');
  });
});

describe('assertNotShellLine', () => {
  it('refuses !ls', () => {
    expect(() => assertNotShellLine('!ls')).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('refuses   !ls (spaces, tabs and newlines before it)', () => {
    expect(() => assertNotShellLine('  !ls')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => assertNotShellLine('\n\t !rm -rf x')).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('refuses a ! hidden behind control bytes the prompt route strips', () => {
    expect(() => assertNotShellLine('\u0001!ls')).toThrow(expect.objectContaining({ code: 'INVALID' }));
    expect(() => assertNotShellLine('\u001b\u0007 !ls')).toThrow(expect.objectContaining({ code: 'INVALID' }));
  });

  it('refuses a ! behind zero-width characters the CLI drops (U+2060!ls)', () => {
    for (const lead of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', ' \u200B\n\u2060\uFEFF\t', '\u0001\u2060 ']) {
      expect(() => assertNotShellLine(`${lead}!ls`), JSON.stringify(lead)).toThrow(expect.objectContaining({ code: 'INVALID' }));
    }
  });

  it('allows a!b, and a ! anywhere but the start', () => {
    expect(() => assertNotShellLine('a!b')).not.toThrow();
    expect(() => assertNotShellLine('fix it!')).not.toThrow();
    expect(() => assertNotShellLine('look at\n!this line')).not.toThrow();
  });

  it('never repeats the text in its words', () => {
    try {
      assertNotShellLine('!cat ~/.ssh/id_rsa');
    } catch (err) {
      expect(`${(err as ToolError).message} ${(err as ToolError).hint}`).not.toMatch(/ssh|id_rsa|cat/);
      return;
    }
    throw new Error('expected a refusal');
  });
});
