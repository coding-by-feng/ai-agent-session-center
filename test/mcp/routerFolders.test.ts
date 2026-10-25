// test/mcp/routerFolders.test.ts — which folder a route works in and which sessions sit in it (Rulings P4-31, P4-14):
// a project central's explicit sub-folder or in-scope project name is routed to, never replaced by its root; a card
// opened under a link spelling of the project is the project's (the real paths are compared, through the injected
// realpath, never the disk); and a candidate is judged as it is after the edited-files reads, not as it was before them.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { envelope, makeCentral, NOW, ok } from './toolHarness.js';
import { A, AGENT, B, HOME, MIN, ROUTES, go, refused, reuseOf, routeDeps, withContext, worker } from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const WEB = `${AGENT}/packages/web`;
const projectCentral = makeCentral('project', AGENT, { centralId: 'proj-1' });

describe('route: a project central names a folder of its own', () => {
  it('a sub-folder it names is routed to, not replaced by its root', async () => {
    const atRoot = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const inWeb = worker(B, WEB);

    for (const project of [WEB, '~/code/agent-manager/packages/web', 'web']) {
      const r = await go({ central: projectCentral, sessions: [atRoot, inWeb] }, { task: 'fix the footer', project }).result;
      expect(r.project, project).toEqual({ folder: WEB, source: 'the project named' });
      expect(reuseOf(r), project).toBe(B);
    }
  });

  it('a new session opens in the sub-folder named', async () => {
    const r = await go({ central: projectCentral, sessions: [worker(A, AGENT)] }, { task: 'fix the footer', project: WEB }).result;

    expect(r.decision).toMatchObject({ kind: 'create', folder: WEB });
  });

  it('its own root named is its own project', async () => {
    const r = await go({ central: projectCentral, sessions: [worker(A, AGENT)] }, { task: 'fix the footer', project: AGENT }).result;

    expect(r.project).toMatchObject({ folder: AGENT });
    expect(reuseOf(r)).toBe(A);
  });

  it('a sub-folder that is not there is refused INVALID, never routed to the root', async () => {
    const missing = `${AGENT}/packages/gone`;
    const deps = routeDeps({ exists: (p) => p !== missing });

    const err = await refused(go({ central: projectCentral, sessions: [worker(A, AGENT)] }, { project: missing }, deps).result);

    expect(err.code).toBe('INVALID');
    expect(err.message).not.toContain(missing);
  });
});

describe('route: a card under a link spelling', () => {
  const LINK = `${HOME}/links/am`;
  const realpath = (p: string): string => (p === LINK || p.startsWith(`${LINK}/`) ? `${AGENT}${p.slice(LINK.length)}` : p);

  it('is reused as a session in the project’s own folder', async () => {
    const linked = worker(A, LINK);

    const r = await go({ sessions: [linked] }, {}, routeDeps({ realpath })).result;

    expect(r.project).toMatchObject({ folder: AGENT });
    expect(reuseOf(r)).toBe(A);
    expect(r.decision.reasons).toContain('same folder');
  });

  it('a link that leads elsewhere, or that does not resolve, stays outside', async () => {
    const elsewhere = worker(A, `${HOME}/links/other`);
    const broken = worker(B, `${HOME}/links/broken`);
    const deps = routeDeps({ realpath: (p) => (p.endsWith('broken') ? null : p) });

    const r = await go({ sessions: [elsewhere, broken] }, {}, deps).result;

    expect(r.decision).toMatchObject({ kind: 'create', folder: AGENT });
    expect(r.runnersUp).toEqual([]);
  });
});

describe('route: candidates after the edited-files reads', () => {
  const changes = (...paths: string[]) =>
    envelope({ files: paths.map((path) => ({ path, added: 3, removed: 1, lastAt: NOW })), total: { added: 3, removed: 1 }, cli: 'claude' });

  it('a session that started working while its files were read is not reused', async () => {
    const a = worker(A, AGENT);
    const b = worker(B, AGENT);
    const sessions: Session[] = [a, b];
    const routes = {
      ...ROUTES,
      [`GET /sessions/${B}/changes`]: () => {
        // A person's prompt lands while the route reads.
        sessions[1] = { ...b, status: 'working' };
        return changes('server/queue/flaky.test.ts');
      },
    };

    const r = await go({ sessions, routes }).result;

    expect(reuseOf(r)).toBe(A);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: B, skipped: 'working' })]);
  });

  it('a session that is gone by then is left out', async () => {
    const a = worker(A, AGENT);
    const b = worker(B, AGENT);
    const sessions: Session[] = [a, b];
    const routes = {
      ...ROUTES,
      [`GET /sessions/${B}/changes`]: () => {
        sessions.splice(1, 1);
        return changes('server/queue/flaky.test.ts');
      },
      'GET /known-projects': ok({ paths: [] }),
    };

    const r = await go({ sessions, routes }).result;

    expect(reuseOf(r)).toBe(A);
    expect(r.runnersUp).toEqual([]);
  });
});
