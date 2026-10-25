// test/mcp/tools.sessionLife.test.ts — resume, reconnect, fork and clone (server/mcp/tools/sessionLife.ts, Task 10,
// Ruling P3-8). Resume and reconnect relaunch an ended card in place (`ctx.mayRelaunch`); fork and clone leave the
// source alone (`ctx.mayEdit(card, { asSource: true })`: scope and kind only) and become the central's own workers. All
// four check the card's stored command (relaunchRule.ts), then go through `openThroughRoute`: the folder rules, the
// permission cap read from the cards (never a body), the plan window and the budgets. The worker opener's real
// dependencies (workerDeps.ts) are replaced and only the fake client answers: nothing here relaunches anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { OpenWorkerDeps } from '../../server/mcp/openWorker.js';
import { allTools } from '../../server/mcp/registry.js';
import type { CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { fail, makeCentral, makeCtx, makeSession, NOW, ok, run, runRefused, type Answer, type CtxOptions } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
const seam = vi.hoisted(() => ({ open: null as unknown }));
vi.mock('../../server/mcp/workerDeps.js', () => ({
  openWorkerDepsFor: () => seam.open,
  routeDepsFor: () => ({}),
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));

const HOME = '/home/u';
const PROJ = `${HOME}/code/app`;
const ID = 's-life-1111';
const TOOLS = ['session_resume', 'session_reconnect', 'session_fork', 'session_clone'] as const;
const ROUTE: Record<(typeof TOOLS)[number], string> = {
  session_resume: 'resume',
  session_reconnect: 'reconnect-terminal',
  session_fork: 'fork',
  session_clone: 'clone',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The central's own card, in `mode`. */
const cardOf = (c: CentralRecord, mode: string | null = 'default'): Session =>
  makeSession(`card-${c.centralId}`, {
    terminalId: c.terminalId,
    status: 'waiting',
    permissionMode: mode,
    central: { centralId: c.centralId, kind: c.kind, scopeRef: c.scopeRef },
  });

/** An ended plain Claude card in the project, started as a bare claude. */
const ended = (over: Partial<Session> = {}): Session =>
  makeSession(ID, {
    status: 'ended',
    cliSource: 'claude',
    projectPath: PROJ,
    startupCommand: 'claude --model sonnet',
    terminalId: null,
    ...over,
  });

let opened = 0;
/** A relaunch route that opens a new terminal each time. */
const opens = (extra: Record<string, unknown> = {}): Answer => () => {
  opened += 1;
  return ok({ ok: true, terminalId: `term-new-${opened}`, ...extra });
};

interface WorldOptions {
  central?: CentralRecord;
  centralMode?: string | null;
  card?: Session;
  extra?: Session[];
  routes?: Record<string, Answer>;
  deps?: Partial<OpenWorkerDeps>;
  ctx?: Partial<CtxOptions>;
}

function world(o: WorldOptions = {}) {
  const central = o.central ?? makeCentral('global', null, { terminalId: 'term-c' });
  const workers: WorkerRegistry = createWorkerRegistry({ controller: () => null });
  const card = o.card ?? ended();
  const routes: Record<string, Answer> = {
    [`POST /sessions/${card.sessionId}/resume`]: opens(),
    [`POST /sessions/${card.sessionId}/reconnect-terminal`]: opens(),
    [`POST /sessions/${card.sessionId}/fork`]: opens(),
    [`POST /sessions/${card.sessionId}/clone`]: opens(),
    ...o.routes,
  };
  const h = makeCtx({ central, sessions: [cardOf(central, o.centralMode ?? 'default'), card, ...(o.extra ?? [])], workers, routes, ...o.ctx });
  seam.open = { knownProjects: async () => [PROJ], home: HOME, realpath: async (p: string) => p, planWindowPct: () => null, now: () => NOW, workers, ...o.deps };
  const posts = () => h.client.calls.filter((c) => c.method === 'POST');
  return { ...h, central, workers, card, posts };
}

interface LifeData {
  sourceSessionId: string;
  terminalId: string;
  newTerminal: boolean;
  own: boolean;
  titled?: boolean;
}

describe('the four relaunches: happy paths', () => {
  it('each calls its route with no body and answers sourceSessionId, terminalId, newTerminal and own', async () => {
    for (const tool of TOOLS) {
      const w = world();
      const result = await run(tool, { id: ID }, w.ctx);
      const data = result.data as LifeData;
      expect(w.posts(), tool).toEqual([{ method: 'POST', path: `/sessions/${ID}/${ROUTE[tool]}` }]);
      const own = tool === 'session_fork' || tool === 'session_clone';
      expect(data, tool).toEqual(expect.objectContaining({ sourceSessionId: ID, terminalId: expect.stringMatching(/^term-new-/), own }));
      // Reconnect always opens a new PTY; resume says so in its answer (not here: its shell was still open).
      expect(data.newTerminal, tool).toBe(tool !== 'session_resume');
      expect(result.activity?.length, tool).toBe(1);
    }
  });

  it('resume passes on the route’s newTerminal', async () => {
    const w = world({ routes: { [`POST /sessions/${ID}/resume`]: opens({ newTerminal: true }) } });
    expect(((await run('session_resume', { id: ID }, w.ctx)).data as LifeData).newTerminal).toBe(true);
  });

  it('they are phase-3 writes of the sessions toolset whose descriptions say the rules', () => {
    for (const name of TOOLS) {
      const tool = allTools().find((t) => t.name === name);
      expect(tool, name).toMatchObject({ toolset: 'sessions', risk: 'write', phase: 3 });
      expect(tool?.description, name).toContain('never looser than your own permission mode');
    }
    const d = (n: string) => allTools().find((t) => t.name === n)?.description ?? '';
    expect(d('session_resume')).toMatch(/ended sessions only/i);
    expect(d('session_reconnect')).toMatch(/ended sessions only/i);
    expect(d('session_resume')).toContain('History in AASC');
    for (const n of ['session_fork', 'session_clone']) expect(d(n)).toContain('your own sessions (at most 8 open, 10 opens a minute)');
  });
});

describe('the permission cap', () => {
  it('a bypass card is not resumed by a default central', async () => {
    const w = world({ card: ended({ permissionMode: 'bypassPermissions' }) });
    const err = await runRefused('session_resume', { id: ID }, w.ctx);
    expect(err.code).toBe('DENIED');
    expect(w.posts()).toEqual([]);

    const flag = world({ card: ended({ permissionMode: 'plan', startupCommand: 'claude --dangerously-skip-permissions' }) });
    expect((await runRefused('session_fork', { id: ID }, flag.ctx)).code).toBe('DENIED');
  });

  it('the cap reads the card, never a body', async () => {
    // A card of mode plan passes under a default central, and no POST carries any body, so none carries a mode.
    for (const tool of TOOLS) {
      const w = world({ card: ended({ permissionMode: 'plan' }) });
      await run(tool, { id: ID }, w.ctx);
      for (const call of w.posts()) expect(call.body, tool).toBeUndefined();
    }
    // A bypass central's own card lets a bypass card through.
    const loose = world({ centralMode: 'bypassPermissions', card: ended({ permissionMode: 'bypassPermissions' }) });
    await run('session_resume', { id: ID }, loose.ctx);
    expect(loose.posts()).toHaveLength(1);
    // The central's record saying bypass is not its card: the card (default) is what caps.
    const record = makeCentral('global', null, { terminalId: 'term-c', permissionMode: 'bypassPermissions' });
    const strict = world({ central: record, centralMode: 'default', card: ended({ permissionMode: 'bypassPermissions' }) });
    expect((await runRefused('session_clone', { id: ID }, strict.ctx)).code).toBe('DENIED');
  });

  it('a Codex card started with --dangerously-bypass-approvals-and-sandbox counts as bypass', async () => {
    const card = ended({ cliSource: 'codex', permissionMode: null, startupCommand: 'codex --dangerously-bypass-approvals-and-sandbox' });
    for (const tool of TOOLS) {
      const w = world({ card });
      expect((await runRefused(tool, { id: ID }, w.ctx)).code, tool).toBe('DENIED');
      expect(w.posts(), tool).toEqual([]);
    }
  });
});

describe('the stored command', () => {
  it('a stored command that is not a bare claude or codex is refused', async () => {
    for (const command of ['caffeinate claude', 'env X=1 claude', 'claude; rm -rf ~', 'npx claude']) {
      for (const tool of TOOLS) {
        const w = world({ card: ended({ startupCommand: command }) });
        const err = await runRefused(tool, { id: ID }, w.ctx);
        expect(err.code, `${tool} ${command}`).toBe('INVALID');
        expect(`${err.message} ${err.hint ?? ''}`).not.toContain(command);
        expect(w.posts(), tool).toEqual([]);
      }
    }
  });

  it('a card with no stored command is reconnected only as an SSH card, as the route allows', async () => {
    const w = world({ card: ended({ startupCommand: undefined, source: 'hook' as Session['source'] }) });
    expect((await runRefused('session_reconnect', { id: ID }, w.ctx)).code).toBe('INVALID');
    expect(w.posts()).toEqual([]);
  });
});

describe('the rails', () => {
  it('resume refuses a running card and a hands-off card', async () => {
    const live = world({ card: ended({ status: 'idle', terminalId: 'term-live' }) });
    expect((await runRefused('session_resume', { id: ID }, live.ctx)).code).toBe('INVALID');
    expect((await runRefused('session_reconnect', { id: ID }, live.ctx)).code).toBe('INVALID');
    const away = world({ card: ended({ handsOff: true }) });
    expect((await runRefused('session_resume', { id: ID }, away.ctx)).code).toBe('HANDS_OFF');
    expect([...live.posts(), ...away.posts()]).toEqual([]);
  });

  it('fork and clone leave the source alone: a running or hands-off card may be forked', async () => {
    for (const tool of ['session_fork', 'session_clone']) {
      const w = world({ card: ended({ status: 'working', handsOff: true, terminalId: 'term-src' }) });
      await run(tool, { id: ID }, w.ctx);
      expect(w.posts(), tool).toHaveLength(1);
    }
  });

  it('another central’s card is refused by all four', async () => {
    for (const tool of TOOLS) {
      const w = world({ card: ended({ central: { centralId: 'central-2', kind: 'global', scopeRef: null } }) });
      expect((await runRefused(tool, { id: ID }, w.ctx)).code, tool).toBe('INVALID');
    }
  });

  it('an SSH card is INVALID', async () => {
    for (const tool of TOOLS) {
      const w = world({ card: ended({ sshHost: 'build.example.com' }) });
      expect((await runRefused(tool, { id: ID }, w.ctx)).code, tool).toBe('INVALID');
      expect(w.posts(), tool).toEqual([]);
    }
  });

  it('a project central cannot fork a card outside its folder', async () => {
    const central = makeCentral('project', PROJ, { terminalId: 'term-c' });
    const outside = ended({ projectPath: `${HOME}/elsewhere` });
    const w = world({ central, card: outside });
    expect((await runRefused('session_fork', { id: ID }, w.ctx)).code).toBe('NOT_IN_SCOPE');
    expect(w.posts()).toEqual([]);
  });

  it('a history id is NOT_FOUND with the History hint', async () => {
    const w = world();
    const err = await runRefused('session_resume', { id: 'hist-0000-unknown' }, w.ctx);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.hint).toContain('resume it from History in AASC');
    expect(err.hint).not.toContain('hist-0000');
  });

  it('a route that refuses is told in AASC’s words', async () => {
    const w = world({ routes: { [`POST /sessions/${ID}/resume`]: fail(400, 'No SSH config stored') } });
    expect((await runRefused('session_resume', { id: ID }, w.ctx)).code).toBe('INVALID');
  });
});

describe('budgets and own workers', () => {
  /** Eight live workers of the central's own, opened long enough ago that the minute's count is clear. */
  function eightLive(w: ReturnType<typeof world>): void {
    for (let i = 0; i < 8; i += 1) {
      const terminalId = `term-w${i}`;
      w.sessions.push(makeSession(`w-${i}-00000`, { terminalId, status: 'working', projectPath: PROJ }));
      w.workers.add({ centralId: w.central.centralId, terminalId, openedAt: NOW - 120_000, folder: PROJ, cli: 'claude' });
    }
  }

  it('fork and clone become own workers and count against 8', async () => {
    for (const tool of ['session_fork', 'session_clone']) {
      const w = world();
      const data = (await run(tool, { id: ID }, w.ctx)).data as LifeData;
      expect(w.workers.of(w.central.centralId).map((x) => x.terminalId), tool).toEqual([data.terminalId]);

      const full = world();
      eightLive(full);
      expect((await runRefused(tool, { id: ID }, full.ctx)).code, tool).toBe('BUDGET');
      expect(full.posts(), tool).toEqual([]);
    }
  });

  it('fork and clone are BUDGET once the central has made 10 opens this minute, and their route is never called', async () => {
    for (const tool of ['session_fork', 'session_clone']) {
      // Ten opens in the minute, none of them a live own worker: the minute's count alone refuses.
      const busy = world();
      for (let i = 0; i < 10; i += 1) busy.workers.noteOpen(busy.central.centralId, NOW - 1_000);
      const err = await runRefused(tool, { id: ID }, busy.ctx);
      expect(err.code, tool).toBe('BUDGET');
      expect(err.message, tool).toBe('A central opens at most 10 sessions a minute.');
      expect(busy.posts(), tool).toEqual([]);
      expect(busy.workers.of(busy.central.centralId), tool).toEqual([]);

      // Nine leave room for one more.
      const nine = world();
      for (let i = 0; i < 9; i += 1) nine.workers.noteOpen(nine.central.centralId, NOW - 1_000);
      await run(tool, { id: ID }, nine.ctx);
      expect(nine.posts(), tool).toHaveLength(1);
    }
  });

  it('resume and reconnect count only a minute’s opens', async () => {
    for (const tool of ['session_resume', 'session_reconnect']) {
      // Eight live own workers do not stop them, and they never become the central's own.
      const w = world();
      eightLive(w);
      await run(tool, { id: ID }, w.ctx);
      expect(w.workers.of(w.central.centralId), tool).toHaveLength(8);
      expect(w.workers.opensSince(w.central.centralId, NOW - 60_000), tool).toBe(1);

      // Ten opens in the minute: the next is BUDGET, and its route is never called.
      const busy = world();
      for (let i = 0; i < 10; i += 1) busy.workers.noteOpen(busy.central.centralId, NOW - 1_000);
      expect((await runRefused(tool, { id: ID }, busy.ctx)).code, tool).toBe('BUDGET');
      expect(busy.posts(), tool).toEqual([]);
    }
  });
});

describe('session_fork title', () => {
  it('fork sets the title on the new terminal', async () => {
    const w = world({ routes: { 'PUT /sessions/term-new-T/title': ok({ ok: true }), [`POST /sessions/${ID}/fork`]: ok({ ok: true, terminalId: 'term-new-T' }) } });

    const result = await run('session_fork', { id: ID, title: 'Try the other fix' }, w.ctx);

    expect(w.client.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/sessions/term-new-T/title', body: { title: 'Try the other fix' } },
    ]);
    expect(result.data).toMatchObject({ terminalId: 'term-new-T', titled: true });
    expect(result.summary).not.toContain('Try the other fix');
  });

  it('a title the route refuses leaves the fork open and says so in data', async () => {
    const w = world({ routes: { [`POST /sessions/${ID}/fork`]: ok({ ok: true, terminalId: 'term-new-U' }) } });
    const result = await run('session_fork', { id: ID, title: 'x' }, w.ctx);
    expect(result.data).toMatchObject({ terminalId: 'term-new-U', titled: false });
    expect(w.workers.of(w.central.centralId)).toHaveLength(1);
  });
});

describe('the stored command’s flags (Ruling P3-23)', () => {
  it('a title word that became a flag in the stored command is refused by all four', async () => {
    for (const command of ['claude -n w --allowedTools Bash', 'claude --add-dir /', 'codex --profile p']) {
      for (const tool of TOOLS) {
        const w = world({ card: ended({ startupCommand: command }) });
        const err = await runRefused(tool, { id: ID }, w.ctx);
        expect(err.code, `${tool} ${command}`).toBe('INVALID');
        expect(`${err.message} ${err.hint ?? ''}`).not.toContain('allowedTools');
        expect(w.posts(), tool).toEqual([]);
      }
    }
  });

  it('every stored command a route may type is judged: the SSH config’s and the sshCommand too', async () => {
    const cfg = { host: 'localhost', port: 22, username: 'u', workingDir: PROJ, command: 'claude --mcp-config x' } as Session['sshConfig'];
    for (const card of [ended({ startupCommand: 'claude', sshConfig: cfg }), ended({ startupCommand: 'claude', sshCommand: 'claude --settings x' })]) {
      for (const tool of TOOLS) {
        const w = world({ card });
        expect((await runRefused(tool, { id: ID }, w.ctx)).code, tool).toBe('INVALID');
        expect(w.posts(), tool).toEqual([]);
      }
    }
  });
});

describe('both folders are judged (Ruling P3-24)', () => {
  const MONO = `${HOME}/mono`;
  const SVC = `${MONO}/svc`;
  /** A card AASC launched in ~/mono (its SSH config's workingDir, where every relaunch opens) that now works in ~/mono/svc. */
  const moved = (): Session =>
    ended({ projectPath: SVC, sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: MONO } as Session['sshConfig'] });

  it('a project central scoped to the folder the card works in cannot relaunch it into the folder it opens in', async () => {
    const central = makeCentral('project', SVC, { terminalId: 'term-c' });
    for (const tool of TOOLS) {
      const w = world({ central, card: moved(), deps: { knownProjects: async () => [MONO, SVC] } });
      const err = await runRefused(tool, { id: ID }, w.ctx);
      expect(err.code, tool).toBe('DENIED');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain('mono');
      expect(w.posts(), tool).toEqual([]);
    }
  });

  it('the registry records the folder the relaunch actually opens', async () => {
    for (const tool of ['session_fork', 'session_clone']) {
      const w = world({ card: moved(), deps: { knownProjects: async () => [MONO, SVC] } });
      await run(tool, { id: ID }, w.ctx);
      expect(w.workers.of(w.central.centralId).map((x) => x.folder), tool).toEqual([MONO]);
    }
  });

  it('an SSH config with no workingDir opens in the home folder, which is refused', async () => {
    const card = ended({ sshConfig: { host: 'localhost', port: 22, username: 'u' } as Session['sshConfig'] });
    const w = world({ card });
    expect((await runRefused('session_clone', { id: ID }, w.ctx)).code).toBe('DENIED');
    expect(w.posts()).toEqual([]);
  });
});

describe('a resume never types into a terminal that is still open (C-M7)', () => {
  it('the route’s TERMINAL_OPEN is UNAVAILABLE in fixed words', async () => {
    const open = { ...fail(409, 'The session’s terminal is still open.'), data: { ok: false, code: 'TERMINAL_OPEN', error: 'still open' } };
    const w = world({ routes: { [`POST /sessions/${ID}/resume`]: () => open } });
    const err = await runRefused('session_resume', { id: ID }, w.ctx);
    expect(err).toMatchObject({
      code: 'UNAVAILABLE',
      message: 'That session’s terminal is still open, so AASC does not type a resume into it for a central.',
    });
    expect(err.hint).toBe('Ask the person, or close its terminal first.');
  });

  it('session_resume’s description says so', () => {
    const d = allTools().find((t) => t.name === 'session_resume')?.description ?? '';
    expect(d).toContain('never into a terminal that is still open');
  });
});

describe('session_fork title rule (Ruling P3-23)', () => {
  it('an explicit title with shell syntax or a dash word is INVALID before anything opens', async () => {
    for (const title of ['x -y ; touch /tmp/p', 'w --allowedTools Bash', "it's"]) {
      const w = world();
      const err = await runRefused('session_fork', { id: ID, title }, w.ctx);
      expect(err.code, title).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(title);
      expect(w.client.calls, title).toEqual([]);
    }
  });

  it('a card whose own title fails the rule is not forked, with or without a title, and nothing opens', async () => {
    for (const card of [ended({ title: 'x -y ; touch /tmp/p' }), ended({ title: '', projectName: '--add-dir' })]) {
      for (const args of [{ id: ID }, { id: ID, title: 'Plain words' }]) {
        const w = world({ card });
        const err = await runRefused('session_fork', args, w.ctx);
        expect(err).toMatchObject({
          code: 'INVALID',
          message: 'This session’s title holds characters a fork would carry into its command.',
          hint: 'Ask the person to rename it, or rename it with session_set_title first.',
        });
        expect(`${err.message} ${err.hint}`).not.toMatch(/touch|add-dir/);
        expect(w.client.calls).toEqual([]);
        expect(w.workers.of(w.central.centralId)).toEqual([]);
      }
    }
    expect(allTools().find((t) => t.name === 'session_fork')?.description).toContain('is not forked (INVALID)');
  });

  it('clone refuses the same card in the same words, and a safe title clones', async () => {
    for (const card of [ended({ title: 'x -y ; touch /tmp/p' }), ended({ title: '', projectName: '--add-dir' })]) {
      const w = world({ card });
      const err = await runRefused('session_clone', { id: ID }, w.ctx);
      expect(err).toMatchObject({
        code: 'INVALID',
        message: 'This session’s title holds characters a clone would carry into its command.',
        hint: 'Ask the person to rename it, or rename it with session_set_title first.',
      });
      expect(`${err.message} ${err.hint}`).not.toMatch(/touch|add-dir/);
      expect(w.client.calls).toEqual([]);
      expect(w.workers.of(w.central.centralId)).toEqual([]);
    }
    const safe = world({ card: ended({ title: 'Fix the login bug' }) });
    await run('session_clone', { id: ID }, safe.ctx);
    expect(safe.posts()).toHaveLength(1);
    expect(allTools().find((t) => t.name === 'session_clone')?.description).toContain('is not cloned (INVALID)');
  });

  it('a safe source title leaves the route’s own Fork of title alone', async () => {
    const w = world({ card: ended({ title: 'Fix the login bug' }) });
    const result = await run('session_fork', { id: ID }, w.ctx);
    expect(w.client.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(result.data).not.toHaveProperty('titled');
  });
});
