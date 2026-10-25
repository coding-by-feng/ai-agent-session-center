// test/mcp/openThroughRoute.test.ts — the route-backed opener (server/mcp/openWorker.ts `openThroughRoute`): a resume,
// reconnect, fork or clone of a card goes through the same folder rules, permission cap, plan window and budgets as a
// new worker, then calls the route the tool names. Nothing here reaches a disk, a process or a real route.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { InternalResponse } from '../../server/mcp/client.js';
import {
  MAX_LIVE_WORKERS,
  MAX_OPENS_PER_MINUTE,
  openThroughRoute,
  type OpenWorkerDeps,
  type RouteOpen,
} from '../../server/mcp/openWorker.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { fail, makeCentral, makeCtx, makeSession, NOW, ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const HOME = '/home/u';
const KNOWN = `${HOME}/known`;

const cardOf = (central: CentralRecord, permissionMode: string | null): Session =>
  makeSession(`card-${central.centralId}`, {
    terminalId: central.terminalId,
    status: 'waiting',
    permissionMode,
    central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
  });

function setup(o: { central?: CentralRecord; centralMode?: string; workers?: WorkerRegistry; deps?: Partial<OpenWorkerDeps>; sessions?: Session[] } = {}) {
  const central = o.central ?? makeCentral('global', null, { terminalId: 'term-c' });
  const workers = o.workers ?? createWorkerRegistry({ controller: () => null });
  const h = makeCtx({ central, sessions: [cardOf(central, o.centralMode ?? 'default'), ...(o.sessions ?? [])], workers });
  const deps: OpenWorkerDeps = {
    knownProjects: async () => [KNOWN],
    home: HOME,
    realpath: async (p) => p,
    planWindowPct: () => null,
    now: () => NOW,
    workers,
    ...o.deps,
  };
  return { ...h, central, workers, deps };
}

let opened = 0;
const answering = (res: InternalResponse<unknown> = ok({ ok: true, terminalId: 'term-new' })) => {
  const call = vi.fn(async () => {
    opened += 1;
    return res.ok ? ok({ ...(res.data as object), terminalId: `term-new-${opened}` }) : res;
  });
  return call;
};

const route = (over: Partial<RouteOpen> = {}): RouteOpen => ({
  cli: 'claude',
  folder: KNOWN,
  own: false,
  mode: 'default',
  call: answering(),
  ...over,
});

async function refused(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

describe('openThroughRoute', () => {
  it('openThroughRoute: own counts against 8 live and 10 a minute; not own against 10 a minute only, and is never own', async () => {
    // Not own: 10 a minute, and nothing becomes the central's own.
    const a = setup();
    for (let i = 0; i < MAX_OPENS_PER_MINUTE; i += 1) {
      const done = await openThroughRoute(a.ctx, route(), a.deps);
      expect(done.terminalId).toMatch(/^term-new-/);
    }
    expect(a.workers.of(a.central.centralId)).toEqual([]);
    expect(a.workers.opensSince(a.central.centralId, NOW - 60_000)).toBe(MAX_OPENS_PER_MINUTE);
    const eleventh = route();
    expect((await refused(openThroughRoute(a.ctx, eleventh, a.deps))).code).toBe('BUDGET');
    expect(eleventh.call).not.toHaveBeenCalled();

    // Own: becomes the central's worker, and 8 live ones stop the 9th.
    const live: Session[] = [];
    const b = setup({ sessions: live });
    for (let i = 0; i < MAX_LIVE_WORKERS; i += 1) {
      const done = await openThroughRoute(b.ctx, route({ own: true }), b.deps);
      expect(done.newTerminal).toBe(true);
      live.push(makeSession(`w${i}`, { terminalId: done.terminalId, status: 'waiting' }));
    }
    const h = setup({ workers: b.workers, sessions: live });
    expect(h.workers.liveCount(h.central.centralId, h.ctx.sessions())).toBe(MAX_LIVE_WORKERS);
    const ninth = route({ own: true });
    const err = await refused(openThroughRoute(h.ctx, ninth, h.deps));
    expect(err).toMatchObject({ code: 'BUDGET', message: `A central keeps at most ${MAX_LIVE_WORKERS} sessions of its own open.` });
    expect(ninth.call).not.toHaveBeenCalled();
    // ...and a not-own open is still let through until the minute's 10.
    await expect(openThroughRoute(h.ctx, route(), h.deps)).resolves.toMatchObject({ newTerminal: false });
  });

  it('openThroughRoute maps 429/400/404/403/409 as listed', async () => {
    const expected: Array<[number, string]> = [
      [429, 'BUDGET'],
      [400, 'INVALID'],
      [404, 'NOT_FOUND'],
      [403, 'DENIED'],
      [409, 'DENIED'],
      [500, 'UPSTREAM'],
      [0, 'UPSTREAM'],
    ];
    for (const [status, code] of expected) {
      const s = setup();
      const err = await refused(openThroughRoute(s.ctx, route({ own: true, call: async () => fail(status, 'route words /home/u/secret') }), s.deps));
      expect(err.code, String(status)).toBe(code);
      expect(err.message).not.toContain('secret');
      expect(s.workers.of(s.central.centralId)).toEqual([]);
    }
    // A 2xx without a terminal id is no open.
    const s = setup();
    expect((await refused(openThroughRoute(s.ctx, route({ call: async () => ok({ ok: true }) }), s.deps))).code).toBe('UPSTREAM');
  });

  it('openThroughRoute judges the folder before it calls', async () => {
    const s = setup();
    for (const folder of ['relative/path', '/etc', HOME]) {
      const r = route({ folder });
      const err = await refused(openThroughRoute(s.ctx, r, s.deps));
      expect(['INVALID', 'DENIED']).toContain(err.code);
      expect(err.message).not.toContain(folder);
      expect(r.call).not.toHaveBeenCalled();
    }
    // A project central reaches its own project only, and a link is judged by where it leads.
    const project = setup({
      central: makeCentral('project', KNOWN, { terminalId: 'term-p' }),
      deps: { knownProjects: async () => [KNOWN, `${HOME}/other`], realpath: async (p) => (p === `${KNOWN}/link` ? `${HOME}/other` : p) },
    });
    const outside = route({ folder: `${HOME}/other` });
    expect((await refused(openThroughRoute(project.ctx, outside, project.deps))).code).toBe('DENIED');
    const linked = route({ folder: `${KNOWN}/link` });
    expect((await refused(openThroughRoute(project.ctx, linked, project.deps))).code).toBe('DENIED');
    expect(outside.call).not.toHaveBeenCalled();
    expect(linked.call).not.toHaveBeenCalled();
    await expect(openThroughRoute(project.ctx, route({ folder: KNOWN }), project.deps)).resolves.toMatchObject({ newTerminal: false });
  });

  it('refuses a mode looser than the central’s card, and an over-full plan window, before it calls', async () => {
    const strict = setup({ centralMode: 'default' });
    const loose = route({ mode: 'bypassPermissions' });
    expect((await refused(openThroughRoute(strict.ctx, loose, strict.deps))).code).toBe('DENIED');
    expect(loose.call).not.toHaveBeenCalled();
    await expect(openThroughRoute(strict.ctx, route({ mode: 'plan' }), strict.deps)).resolves.toBeDefined();

    const full = setup({ deps: { planWindowPct: () => 95 } });
    const r = route();
    expect((await refused(openThroughRoute(full.ctx, r, full.deps))).code).toBe('BUDGET');
    expect(r.call).not.toHaveBeenCalled();
  });

  it('records an own open as the central’s worker in the real folder, with its CLI', async () => {
    const s = setup({ deps: { realpath: async (p) => (p === `${KNOWN}/via-link` ? KNOWN : p) } });
    const done = await openThroughRoute(s.ctx, route({ own: true, cli: 'codex', folder: `${KNOWN}/via-link` }), s.deps);

    expect(s.workers.of(s.central.centralId)).toEqual([
      { centralId: s.central.centralId, terminalId: done.terminalId, openedAt: NOW, folder: KNOWN, cli: 'codex' },
    ]);
  });
});
