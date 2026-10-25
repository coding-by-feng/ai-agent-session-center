// test/mcp/routerHandoff.test.ts — the router's hand-off asks the policy's hand-off rails (Ruling P4-27): a child central
// the rails refuse (hands-off, busy with a task, a person at it) is passed over with its code as a reason, and routing
// falls through to the next owner, then reuse, then create. A hand-off says in its reasons what it does not pass on
// (Ruling P4-31). Nothing here touches the disk.
import { describe, expect, it, vi } from 'vitest';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import type { Ledger } from '../../server/mcp/ledger.js';
import type { Session } from '../../src/types/session.js';
import { makeRoom, type CtxOptions } from './toolHarness.js';
import { A, AGENT, B, GLOBAL, HOME, childCentral, go, reuseOf, worker } from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

type Child = ReturnType<typeof childCentral>;

const lockedOn = (...ids: string[]): Ledger => ({ ...unwiredLedger, isLocked: (id) => ids.includes(id) });

/** The global central with these child centrals live and these other sessions; A sits in the room r1. */
function world(kids: Child[], extra: Session[], over: Partial<CtxOptions> = {}): CtxOptions {
  return {
    central: GLOBAL,
    centrals: [GLOBAL, ...kids.map((k) => k.record)],
    sessions: [...extra, ...kids.map((k) => k.card)],
    rooms: [makeRoom('r1', [A])],
    ...over,
  };
}

describe('route: the hand-off rails', () => {
  it('a hands-off project central is passed over, not failed on', async () => {
    const child = childCentral('project', AGENT, 'proj-1', { handsOff: true });

    const reuse = await go(world([child], [worker(B, AGENT)])).result;
    expect(reuseOf(reuse)).toBe(B);
    expect(reuse.decision.reasons).toContain('central #proj-1 passed over (HANDS_OFF)');

    const create = await go(world([child], [])).result;
    expect(create.decision).toMatchObject({ kind: 'create', folder: AGENT });
    expect(create.decision.reasons).toContain('central #proj-1 passed over (HANDS_OFF)');
  });

  it('a busy child central is passed over', async () => {
    const near = childCentral('project', AGENT, 'proj-1');
    const wide = childCentral('project', `${HOME}/code`, 'proj-wide');

    const r = await go(world([near, wide], [], { ledger: lockedOn(near.card.sessionId) })).result;

    expect(r.decision).toMatchObject({ kind: 'handoff', centralId: 'proj-wide' });
    expect(r.decision.reasons).toEqual(['a project central owns this folder', 'central #proj-1 passed over (BUSY)']);
  });

  it('after the project centrals, the room central is asked', async () => {
    const project = childCentral('project', AGENT, 'proj-1');
    const room = childCentral('room', 'r1', 'room-1');

    const r = await go(world([project, room], [worker(A, AGENT, { status: 'working' })], { ledger: lockedOn(project.card.sessionId) })).result;

    expect(r.decision).toMatchObject({ kind: 'handoff', centralId: 'room-1' });
    expect(r.decision.reasons).toContain('central #proj-1 passed over (BUSY)');
  });

  it('a person at the child central passes it over too', async () => {
    const child = childCentral('project', AGENT, 'proj-1');
    const controller = (id: string) => (id === child.card.sessionId ? { clientId: 'window-1', lastActivityAt: Date.now() } : null);

    const r = await go(world([child], [worker(B, AGENT)], { controller })).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.decision.reasons).toContain('central #proj-1 passed over (HUMAN_ACTIVE)');
  });

  it('a hand-off says the CLI and model asked for are not passed on', async () => {
    const child = childCentral('project', AGENT, 'proj-1');

    const both = await go(world([child], []), { cli: 'codex', model: 'gpt-5' }).result;
    expect(both.decision.kind).toBe('handoff');
    expect(both.decision.reasons).toContain('the CLI and model asked for are not passed on: the central picks its own sessions');

    const cli = await go(world([child], []), { cli: 'codex' }).result;
    expect(cli.decision.reasons).toContain('the CLI asked for is not passed on: the central picks its own sessions');

    const none = await go(world([child], [])).result;
    expect(none.decision.reasons).toEqual(['a project central owns this folder']);
  });
});
