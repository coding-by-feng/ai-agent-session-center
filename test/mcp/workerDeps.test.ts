// test/mcp/workerDeps.test.ts — the real dependencies the P4 tools route and open with (server/mcp/workerDeps.ts,
// Ruling P4-18), which every tool test replaces: the known roots from GET /known-projects on the central's own
// client, this user's home, fs's realpath, and the freshest 5-hour plan-window reading of a CLI. The client is a fake;
// realpath is only asked about this test's own folder and a name that does not exist beside it.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PlanUsage, Session } from '../../src/types/session.js';
import { knownRootsOf, openWorkerDepsFor, planWindowPct, routeDepsFor } from '../../server/mcp/workerDeps.js';
import { fail, makeCtx, makeSession, NOW, ok } from './toolHarness.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const usage = (cli: PlanUsage['cli'], asOf: number, fiveHour: number | null, weekly = 10): PlanUsage => ({
  cli,
  asOf,
  windows: [
    ...(fiveHour === null ? [] : [{ minutes: 300, usedPercent: fiveHour, resetsAt: null }]),
    { minutes: 10_080, usedPercent: weekly, resetsAt: null },
  ],
});

const carrying = (id: string, planUsage: PlanUsage | null): Session => makeSession(id, { planUsage });

describe('knownRootsOf', () => {
  it('reads the folders GET /known-projects lists, and drops what is no folder name', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /known-projects': ok({ paths: ['/a/app', 7, '/b/api', null] }) } });

    expect(await knownRootsOf(ctx)).toEqual(['/a/app', '/b/api']);
    expect(client.calls).toEqual([expect.objectContaining({ method: 'GET', path: '/known-projects' })]);
  });

  it('is none when the route fails or answers something else', async () => {
    expect(await knownRootsOf(makeCtx({ routes: { 'GET /known-projects': fail(500, 'boom') } }).ctx)).toEqual([]);
    expect(await knownRootsOf(makeCtx({ routes: { 'GET /known-projects': ok({ folders: ['/a'] }) } }).ctx)).toEqual([]);
  });
});

describe('planWindowPct', () => {
  it('takes the 5-hour window of the newest reading of that CLI', () => {
    const sessions = [
      carrying('old', usage('claude', NOW - 5_000, 20)),
      carrying('new', usage('claude', NOW, 64)),
      carrying('codex', usage('codex', NOW + 1_000, 99)),
      carrying('none', null),
    ];

    expect(planWindowPct(sessions, 'claude', NOW)).toBe(64);
    expect(planWindowPct(sessions, 'codex', NOW)).toBe(99);
  });

  it('is null with no reading, or a newest reading without a 5-hour window', () => {
    expect(planWindowPct([carrying('none', null)], 'claude', NOW)).toBeNull();
    expect(planWindowPct([carrying('old', usage('claude', 1, 30)), carrying('new', usage('claude', 2, null))], 'claude', NOW)).toBeNull();
  });
});

describe('a plan window that has reset', () => {
  const resetAt = (cli: PlanUsage['cli'], used: number, resetsAt: number | null): PlanUsage => ({
    cli,
    asOf: NOW - 3 * 3_600_000,
    windows: [{ minutes: 300, usedPercent: used, resetsAt }],
  });

  it('a reading whose window already reset does not refuse a worker', () => {
    // Codex read 95 % three hours ago, its window reset an hour ago, and no Codex session has run since.
    const sessions = [carrying('codex', resetAt('codex', 95, NOW - 3_600_000))];

    expect(planWindowPct(sessions, 'codex', NOW)).toBeNull();
    expect(openWorkerDepsFor(makeCtx({ sessions, now: NOW }).ctx).planWindowPct('codex')).toBeNull();
  });

  it('a window that resets later, or has no reset time, still counts', () => {
    expect(planWindowPct([carrying('c', resetAt('codex', 95, NOW + 60_000))], 'codex', NOW)).toBe(95);
    expect(planWindowPct([carrying('c', resetAt('codex', 95, null))], 'codex', NOW)).toBe(95);
    // The reset is judged by the context's clock.
    expect(openWorkerDepsFor(makeCtx({ sessions: [carrying('c', resetAt('codex', 95, NOW + 60_000))], now: NOW + 60_000 }).ctx).planWindowPct('codex')).toBeNull();
  });
});

describe('openWorkerDepsFor', () => {
  it('opens with this home, the known roots, the plan window of the context’s sessions and its clock', async () => {
    const { ctx } = makeCtx({
      routes: { 'GET /known-projects': ok({ paths: ['/a/app'] }) },
      sessions: [carrying('s1', usage('claude', NOW, 42))],
      now: NOW + 9,
    });
    const deps = openWorkerDepsFor(ctx);

    expect(deps.home).toBe(homedir());
    expect(await deps.knownProjects()).toEqual(['/a/app']);
    expect(deps.planWindowPct('claude')).toBe(42);
    expect(deps.planWindowPct('codex')).toBeNull();
    expect(deps.now()).toBe(NOW + 9);
    // No registry of its own: the opener falls back to the server's.
    expect(deps.workers).toBeUndefined();
  });

  it('resolves a real folder and rejects a name that does not exist', async () => {
    const deps = openWorkerDepsFor(makeCtx().ctx);

    expect(await deps.realpath(HERE)).toBe(await deps.realpath(join(HERE, '.')));
    await expect(deps.realpath(join(HERE, 'no-such-folder-p4'))).rejects.toThrow();
  });
});

describe('routeDepsFor', () => {
  it('routes with this home and the router’s own defaults for the rest', () => {
    expect(routeDepsFor(makeCtx().ctx)).toEqual({ home: homedir() });
  });
});
