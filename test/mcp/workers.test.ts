// test/mcp/workers.test.ts — a central's own workers (server/mcp/workers.ts, Ruling P4-3): kept by terminal id, so the
// `term-…` → CLI-id re-key keeps them; released when the terminal exits, when a person drives one after it opened, when
// the central is revoked, or when AASC closes it. What being own gives is tested where it is used: a room central's
// scope (scopePredicate.test.ts), the unattended lock (unattended.test.ts) and queue_add_item (tools.queueWriteLock.test.ts);
// the re-key case runs through all three here, as the review focus asks.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { contextFor, neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { assertMayStartUnattended } from '../../server/mcp/unattended.js';
import {
  createWorkerRegistry,
  wireWorkerReleases,
  workers as serverWorkers,
  workersFor,
  type OwnWorker,
  type WorkerController,
} from '../../server/mcp/workers.js';
import { fakeBus, fakeTerminalExits, globalInput, roomInput } from './centralFixtures.js';
import { fakeClient, makeRoom, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const OPENED = 1_000;

const own = (centralId: string, terminalId: string, over: Partial<OwnWorker> = {}): OwnWorker => ({
  centralId,
  terminalId,
  openedAt: OPENED,
  folder: '/a/proj',
  cli: 'claude',
  ...over,
});

/** A registry whose presence answers from `who` (sessionId → controller), nobody by default. */
function registry(who: Record<string, WorkerController | null> = {}) {
  const controllers = { ...who };
  const reg = createWorkerRegistry({ controller: (sessionId) => controllers[sessionId] ?? null });
  const changes = vi.fn();
  reg.onChange(changes);
  return { reg, controllers, changes };
}

describe('the own-worker registry', () => {
  it('add then isOwn by terminal', () => {
    const { reg } = registry();
    reg.add(own('c1', 'term-1'));
    const card = makeSession('term-1', { terminalId: 'term-1' });

    expect(reg.isOwn('c1', card)).toBe(true);
    expect(reg.ownerOf(card)).toBe('c1');
    expect(reg.isOwn('c2', card)).toBe(false);
    // Matched by terminal, never by session id: the same id in another terminal is not the worker.
    expect(reg.isOwn('c1', makeSession('term-1', { terminalId: 'term-9' }))).toBe(false);
    expect(reg.isOwn('c1', makeSession('term-1', { terminalId: null }))).toBe(false);
    expect(reg.of('c1')).toEqual([own('c1', 'term-1')]);
    expect(reg.of('c2')).toEqual([]);
  });

  it('answers copies: what it hands out cannot change what it keeps', () => {
    const { reg } = registry();
    const added = own('c1', 'term-1');
    reg.add(added);
    (added as { centralId: string }).centralId = 'c2';
    (reg.of('c1')[0] as { terminalId: string }).terminalId = 'term-x';

    expect(reg.ownerOf(makeSession('term-1', { terminalId: 'term-1' }))).toBe('c1');
    expect(reg.of('c1')[0].terminalId).toBe('term-1');
  });

  it('ownership follows the re-key', () => {
    const { reg } = registry();
    const centrals = createCentralRegistry();
    const central = centrals.mint(roomInput('r1'));
    reg.add(own(central.centralId, 'term-1'));
    const before = makeSession('term-1', { terminalId: 'term-1' });
    const after = makeSession('cli-abc', { terminalId: 'term-1' });
    let sessions: Session[] = [before];
    const deps: McpDeps = {
      registry: centrals,
      client: () => fakeClient(),
      sessions: () => sessions,
      rooms: () => [makeRoom('r1', [])],
      events: createEventHub(fakeBus().subscribe),
      now: () => NOW,
      workers: reg,
    };

    expect(reg.isOwn(central.centralId, before)).toBe(true);
    sessions = [after];
    const ctx = contextFor(central.centralId, deps, neverAborted);

    // The CLI's first hook re-keyed the card; the terminal is the same, so it is still the central's own worker: in its
    // room scope before any room lists it, and let through the unattended lock.
    expect(reg.isOwn(central.centralId, after)).toBe(true);
    expect(ctx.inScope(after)).toBe(true);
    expect(ctx.scopedSessions().map((s) => s.sessionId)).toEqual(['cli-abc']);
    expect(() => assertMayStartUnattended(ctx, after)).not.toThrow();
  });

  it('a person typing adopts the worker', () => {
    const { reg, controllers, changes } = registry();
    reg.add(own('c1', 'term-1'));
    changes.mockClear();
    const card = makeSession('cli-abc', { terminalId: 'term-1' });

    // The central itself holds the controls after the open, and a person's activity from before it opened counts for nothing.
    controllers['cli-abc'] = { clientId: 'mcp:c1', lastActivityAt: OPENED + 500, lastInputAt: OPENED + 500 };
    expect(reg.isOwn('c1', card)).toBe(true);
    controllers['cli-abc'] = { clientId: 'device-1', lastActivityAt: OPENED - 1, lastInputAt: OPENED - 1 };
    expect(reg.isOwn('c1', card)).toBe(true);
    // A person's act that is not input (a resize, a clear) does not adopt it (Ruling P4-23).
    controllers['cli-abc'] = { clientId: 'device-1', lastActivityAt: OPENED + 1 };
    expect(reg.isOwn('c1', card)).toBe(true);
    expect(changes).not.toHaveBeenCalled();

    controllers['cli-abc'] = { clientId: 'device-1', lastActivityAt: OPENED + 1, lastInputAt: OPENED + 1 };
    expect(reg.ownerOf(card)).toBeNull();
    expect(changes).toHaveBeenCalledTimes(1);

    // Released for good: the central taking the controls back does not make it its own again.
    controllers['cli-abc'] = { clientId: 'mcp:c1', lastActivityAt: OPENED + 9_000 };
    expect(reg.isOwn('c1', card)).toBe(false);
    expect(reg.of('c1')).toEqual([]);
  });

  it('terminal exit releases', () => {
    const { reg, changes } = registry();
    const exits = fakeTerminalExits();
    wireWorkerReleases(reg, { onTerminalExit: exits.subscribe, centrals: createCentralRegistry() });
    reg.add(own('c1', 'term-1'));
    reg.add(own('c1', 'term-2'));
    changes.mockClear();

    exits.exit('term-1');

    expect(reg.isOwn('c1', makeSession('cli-abc', { terminalId: 'term-1' }))).toBe(false);
    expect(reg.of('c1').map((w) => w.terminalId)).toEqual(['term-2']);
    expect(changes).toHaveBeenCalledTimes(1);
    // A terminal that was no worker's changes nothing.
    exits.exit('term-elsewhere');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('revoking the central releases all its workers', () => {
    const { reg } = registry();
    const centrals = createCentralRegistry();
    const gone = centrals.mint(globalInput());
    const stays = centrals.mint(roomInput('r1'));
    wireWorkerReleases(reg, { onTerminalExit: fakeTerminalExits().subscribe, centrals });
    reg.add(own(gone.centralId, 'term-1'));
    reg.add(own(gone.centralId, 'term-2'));
    reg.add(own(stays.centralId, 'term-3'));

    // A new token is the same central: its workers stay its own.
    centrals.rotate(gone.centralId);
    expect(reg.of(gone.centralId)).toHaveLength(2);

    centrals.revoke(gone.centralId);

    expect(reg.of(gone.centralId)).toEqual([]);
    expect(reg.isOwn(gone.centralId, makeSession('w', { terminalId: 'term-1' }))).toBe(false);
    expect(reg.of(stays.centralId).map((w) => w.terminalId)).toEqual(['term-3']);
  });

  it('liveCount ignores ended cards', () => {
    const { reg } = registry();
    for (const t of ['term-1', 'term-2', 'term-3']) reg.add(own('c1', t));
    reg.add(own('c2', 'term-4'));
    const sessions = [
      makeSession('a', { terminalId: 'term-1', status: 'idle' }),
      makeSession('b', { terminalId: 'term-2', status: 'working' }),
      makeSession('c', { terminalId: 'term-3', status: 'ended' }),
      makeSession('d', { terminalId: 'term-4', status: 'idle' }),
      makeSession('e', { terminalId: 'term-5', status: 'idle' }),
    ];

    expect(reg.liveCount('c1', sessions)).toBe(2);
    expect(reg.liveCount('c2', sessions)).toBe(1);
    expect(reg.liveCount('nobody', sessions)).toBe(0);
    // Two cards on one terminal (a stale one beside its re-keyed one) are one worker.
    expect(reg.liveCount('c1', [...sessions, makeSession('a2', { terminalId: 'term-1', status: 'idle' })])).toBe(2);
  });

  it('counts each central’s opens, released workers included, for the rolling-minute budget', () => {
    const { reg } = registry();
    reg.add(own('c1', 'term-1', { openedAt: 10_000 }));
    reg.add(own('c1', 'term-2', { openedAt: 50_000 }));
    reg.add(own('c2', 'term-3', { openedAt: 50_000 }));
    reg.release('term-2', 'closed');

    expect(reg.opensSince('c1', 0)).toBe(2);
    expect(reg.opensSince('c1', 20_000)).toBe(1);
    expect(reg.opensSince('c2', 20_000)).toBe(1);
    expect(reg.opensSince('nobody', 0)).toBe(0);
  });

  it('the server’s registry holds nothing until a central opens a worker', () => {
    expect(serverWorkers.of('any-central')).toEqual([]);
  });
});

describe('a call’s view of the registry (ToolContext.workers)', () => {
  it('answers for the calling central only', () => {
    const { reg } = registry();
    reg.add(own('c1', 'term-1'));
    reg.add(own('c2', 'term-2'));
    const mine = makeSession('a', { terminalId: 'term-1' });
    const theirs = makeSession('b', { terminalId: 'term-2' });
    const view = workersFor(reg, 'c1');

    expect(view.isOwn('c1', mine)).toBe(true);
    expect(view.isOwn('c2', theirs)).toBe(false);
    expect(view.of('c2')).toEqual([]);
    expect(view.liveCount('c2', [mine, theirs])).toBe(0);
    expect(view.liveCount('c1', [mine, theirs])).toBe(1);
  });
});
