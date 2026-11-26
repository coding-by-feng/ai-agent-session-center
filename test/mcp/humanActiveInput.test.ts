// test/mcp/humanActiveInput.test.ts — the 60-second rule (policy.ts HUMAN_ACTIVE, promptRouter's `personActive`) counts
// a person's input only. The baton (presenceManager) also moves on a resize, a clear, a focus report and the terminal's
// own replies (wsManager `holdsControl` with drives = false), which a browser sends whenever it shows or re-fits a
// card: counting those kept a central's fresh, idle worker refused with HUMAN_ACTIVE, the minute restarting on every
// re-fit (the hint grew from 13 s to 50 s between two calls 15 s apart). The real presence store is used here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMaySteer, HUMAN_ACTIVE_MS, SteerRefusal, type SteerContext } from '../../server/mcp/policy.js';
import { _resetForTests, getController, noteControlActivity } from '../../server/presenceManager.js';
import { makeCentral, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const WORKER = '9227641f-ba7b-45c7-b4e8-14cac2b2761c';
const central = makeCentral();
const worker = makeSession(WORKER, { terminalId: 'term-1795556040403-o4x7im', status: 'idle' });

let clock = NOW;
const ctx: SteerContext = {
  inScope: () => true,
  controller: getController,
  isLocked: () => false,
  isOpsTerminal: () => false,
  now: () => clock,
};

function refusalOf(): SteerRefusal | null {
  try {
    assertMaySteer(central, worker, ctx);
    return null;
  } catch (err) {
    if (err instanceof SteerRefusal) return err;
    throw err;
  }
}

beforeEach(() => {
  clock = NOW;
  _resetForTests(() => clock);
});
afterEach(() => {
  _resetForTests();
});

describe('HUMAN_ACTIVE counts a person’s input only', () => {
  it('a browser showing and re-fitting a new worker (resize, focus, terminal replies) never refuses it', () => {
    // The desktop opens the new card: a fit, then a focus report and a Device Attributes reply, then a re-fit.
    noteControlActivity(WORKER, 'desktop-1', false);
    clock += 2_000;
    noteControlActivity(WORKER, 'desktop-1', false);
    expect(refusalOf()).toBeNull();
    // 15 s later the layout re-fits again (the card was filed into its room): still not a person driving it.
    clock += 15_000;
    noteControlActivity(WORKER, 'desktop-1', false);
    expect(getController(WORKER)?.clientId).toBe('desktop-1');
    expect(refusalOf()).toBeNull();
  });

  it('a person typing still refuses it for 60 s, and a later re-fit does not restart the minute', () => {
    noteControlActivity(WORKER, 'desktop-1', true);
    clock += 47_000;
    expect(refusalOf()).toMatchObject({ code: 'HUMAN_ACTIVE', hint: 'Try again in 13 s, or pick another session.' });
    noteControlActivity(WORKER, 'desktop-1', false);
    clock += 13_000;
    expect(refusalOf()).toBeNull();
    expect(HUMAN_ACTIVE_MS).toBe(60_000);
  });
});
