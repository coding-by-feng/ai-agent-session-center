// test/mcp/policyEscHold.test.ts — Ruling 47: a person's Esc holds a session against centrals the way it holds the
// queue (sessionStore's `userCancelledAt`, cleared by their next prompt). The stamp a central's own Esc causes (it
// lands 150-600 ms after that Esc) is not a hold: escHold.ts keeps when a central last pressed Esc.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { CENTRAL_ESC_GRACE_MS, createCentralEscBook, isEscHeld } from '../../server/mcp/escHold.js';
import { assertMaySteer, SteerRefusal, type SteerContext } from '../../server/mcp/policy.js';
import type { CentralRecord } from '../../server/mcp/types.js';
import { makeCentral, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const worker = (over: Partial<Session> = {}): Session =>
  makeSession('w1', { terminalId: 'term-w1', status: 'waiting', ...over });

const steerCtx = (over: Partial<SteerContext> = {}): SteerContext => ({
  inScope: () => true,
  controller: () => null,
  isLocked: () => false,
  isOpsTerminal: () => false,
  now: () => NOW,
  ...over,
});

function refusal(central: CentralRecord, session: Session, ctx: SteerContext): SteerRefusal | null {
  try {
    assertMaySteer(central, session, ctx);
    return null;
  } catch (err) {
    if (err instanceof SteerRefusal) return err;
    throw err;
  }
}

const central = makeCentral();
const STAMP = NOW - 5_000;

describe('the Esc hold in assertMaySteer', () => {
  it('steering refuses while the person’s Esc hold is set, but not right after the central’s own Esc', () => {
    const held = refusal(central, worker({ userCancelledAt: STAMP }), steerCtx());
    expect(held?.code).toBe('HUMAN_ACTIVE');
    expect(held?.message).toMatch(/stopped/i);
    // The central pressed Esc 300 ms before the stamp landed: the stamp is its own Esc's.
    const own = steerCtx({ centralEscAt: (id) => (id === 'w1' ? STAMP - 300 : null) });
    expect(refusal(central, worker({ userCancelledAt: STAMP }), own)).toBeNull();
  });

  it('holds when the central’s Esc came after the stamp, or long before it', () => {
    const after = steerCtx({ centralEscAt: () => STAMP + 1_000 });
    expect(refusal(central, worker({ userCancelledAt: STAMP }), after)?.code).toBe('HUMAN_ACTIVE');
    const long = steerCtx({ centralEscAt: () => STAMP - CENTRAL_ESC_GRACE_MS - 1 });
    expect(refusal(central, worker({ userCancelledAt: STAMP }), long)?.code).toBe('HUMAN_ACTIVE');
  });

  it('lets the session through once the stamp is cleared (the person prompted it again)', () => {
    expect(refusal(central, worker({ userCancelledAt: null }), steerCtx())).toBeNull();
    expect(refusal(central, worker(), steerCtx())).toBeNull();
  });

  it('asks about the session and its terminal', () => {
    const asked: Array<[string, string | null]> = [];
    refusal(
      central,
      worker({ userCancelledAt: STAMP }),
      steerCtx({
        centralEscAt: (id, terminal) => {
          asked.push([id, terminal]);
          return null;
        },
      }),
    );
    expect(asked).toEqual([['w1', 'term-w1']]);
  });

  it('comes after hands-off and the 60-second rule, and before the lock', () => {
    const session = worker({ userCancelledAt: STAMP });
    expect(refusal(central, { ...session, handsOff: true }, steerCtx())?.code).toBe('HANDS_OFF');
    const person = steerCtx({ controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 1_000 }) });
    expect(refusal(central, session, person)?.message).toMatch(/less than a minute/);
    expect(refusal(central, session, steerCtx({ isLocked: () => true }))?.code).toBe('HUMAN_ACTIVE');
  });

  it('never names the session in its words', () => {
    const held = refusal(central, worker({ userCancelledAt: STAMP }), steerCtx());
    expect(`${held?.message} ${held?.hint}`).not.toContain('w1');
    expect(held?.sessionId).toBe('w1');
  });
});

describe('isEscHeld', () => {
  it('is held for a stamp and no central Esc, free for no stamp', () => {
    expect(isEscHeld(STAMP, null)).toBe(true);
    expect(isEscHeld(null, null)).toBe(false);
    expect(isEscHeld(undefined, STAMP)).toBe(false);
  });

  it('takes a stamp up to the grace after a central Esc as that Esc’s', () => {
    expect(isEscHeld(STAMP, STAMP)).toBe(false);
    expect(isEscHeld(STAMP, STAMP - CENTRAL_ESC_GRACE_MS)).toBe(false);
    expect(isEscHeld(STAMP, STAMP - CENTRAL_ESC_GRACE_MS - 1)).toBe(true);
    expect(isEscHeld(STAMP, STAMP + 1)).toBe(true);
  });
});

describe('createCentralEscBook', () => {
  it('keeps the last central Esc by session and by terminal', () => {
    const book = createCentralEscBook(() => NOW);
    expect(book.at('w1', 'term-w1')).toBeNull();
    book.note('w1', 'term-w1');
    expect(book.at('w1')).toBe(NOW);
    // After a re-key the terminal still finds it.
    expect(book.at('cli-id', 'term-w1')).toBe(NOW);
    book.note('cli-id', null, NOW + 50);
    expect(book.at('cli-id', 'term-w1')).toBe(NOW + 50);
  });

  it('forgets the oldest notes past its bound', () => {
    const book = createCentralEscBook(() => NOW);
    for (let i = 0; i < 600; i += 1) book.note(`s${i}`, null, NOW + i);
    expect(book.at('s0')).toBeNull();
    expect(book.at('s599')).toBe(NOW + 599);
  });
});
