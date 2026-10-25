// test/mcp/openWorker.test.ts — the one way a central opens a session (server/mcp/openWorker.ts): the folder rules
// (the central's scope, the launch rule on the written and the real path), the permission cap from the central's card
// (Ruling P4-5), the budgets, the exact POST /terminals body, the route's answers, the own-worker record and the room
// filing. Nothing here reaches a disk, a process or a real route: the folder, the plan window and /api are stand-ins.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import {
  openWorker,
  openedWorkerNote,
  ROOM_FILED_LATER,
  type OpenWorkerDeps,
  type WorkerSpec,
} from '../../server/mcp/openWorker.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { fail, makeCentral, makeCtx, makeRoom, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const HOME = '/home/u';
const KNOWN = `${HOME}/known`;
const NEW_TERMINAL = 'term-new-1';

const opened = (): Answer => ok({ ok: true, terminalId: NEW_TERMINAL });
const filed = (): Answer => ok({ ok: true, opId: 'op-1' }, 202);

/** The central's own card: its marker, its terminal, the permission mode it runs with. */
const cardOf = (central: CentralRecord, permissionMode: string | null): Session =>
  makeSession(`card-${central.centralId}`, {
    terminalId: central.terminalId,
    status: 'waiting',
    permissionMode,
    central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
  });

interface Setup {
  central?: CentralRecord;
  /** The central card's permission mode; 'default' when left out. */
  centralMode?: string | null;
  sessions?: Session[];
  rooms?: ReturnType<typeof makeRoom>[];
  routes?: Record<string, Answer>;
  workers?: WorkerRegistry;
  deps?: Partial<OpenWorkerDeps>;
}

function setup(o: Setup = {}) {
  const central = o.central ?? makeCentral('global', null, { terminalId: 'term-c' });
  const workers = o.workers ?? createWorkerRegistry({ controller: () => null });
  const card = cardOf(central, o.centralMode === undefined ? 'default' : o.centralMode);
  const h = makeCtx({
    central,
    sessions: [card, ...(o.sessions ?? [])],
    rooms: o.rooms ?? [],
    workers,
    routes: { 'POST /terminals': opened(), 'POST /rooms/ops': filed(), ...o.routes },
  });
  const deps: OpenWorkerDeps = {
    knownProjects: async () => [KNOWN],
    home: HOME,
    realpath: async (p) => p,
    planWindowPct: () => null,
    now: () => NOW,
    workers,
    ...o.deps,
  };
  const posts = (path: string) => h.client.calls.filter((c) => c.method === 'POST' && c.path === path);
  return { ...h, central, workers, deps, posts };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({ cli: 'claude', folder: KNOWN, title: 'Fix the build', ...over });

async function refused(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('openWorker let it through');
}

describe('openWorker', () => {
  it('the body is exactly the allowed fields', async () => {
    const s = setup({ centralMode: 'acceptEdits' });
    const w = await openWorker(s.ctx, spec({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }), s.deps);

    const [call] = s.posts('/terminals');
    expect(call.body).toEqual({
      forceNew: true,
      requireExistingDir: true,
      workingDir: KNOWN,
      command: 'claude --permission-mode acceptEdits',
      sessionTitle: 'Fix the build',
      model: 'opus',
      effortLevel: 'high',
      permissionMode: 'acceptEdits',
    });
    const never = ['central', 'startupCommand', 'host', 'username', 'tmuxSession', 'apiKey', 'enableOpsTerminal'];
    for (const key of [...never, 'remoteVisible', 'handsOff', 'pinned']) expect(call.body).not.toHaveProperty(key);
    expect(w).toEqual({
      terminalId: NEW_TERMINAL,
      sessionId: NEW_TERMINAL,
      folder: KNOWN,
      cli: 'claude',
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      roomId: null,
      filed: false,
      note: null,
    });
    expect(s.workers.of(s.central.centralId)).toEqual([
      { centralId: s.central.centralId, terminalId: NEW_TERMINAL, openedAt: NOW, folder: KNOWN, cli: 'claude' },
    ]);
    expect(s.posts('/rooms/ops')).toEqual([]);
    // The activity note says what happened in ids and words of AASC's own: never the folder or the title.
    const note = openedWorkerNote(w);
    expect(note.targetSessionId).toBe(NEW_TERMINAL);
    expect(note.summary).not.toMatch(/known|Fix the build/);
  });

  it('forceNew and requireExistingDir are always sent', async () => {
    for (const cli of ['claude', 'codex'] as const) {
      const s = setup();
      await openWorker(s.ctx, spec({ cli }), s.deps);
      const [call] = s.posts('/terminals');
      expect(call.body, cli).toMatchObject({ forceNew: true, requireExistingDir: true, command: cli });
      expect(call.body).not.toHaveProperty('model');
      expect(call.body).not.toHaveProperty('effortLevel');
    }
  });

  it('refuses a model, an effort or a title it would not pass on, before anything opens', async () => {
    const bad: Partial<WorkerSpec>[] = [
      { model: 'opus; rm -rf ~' },
      { effort: 'ludicrous' },
      { cli: 'codex', effort: 'max' },
      { cli: 'claude', effort: 'minimal' },
      { title: '   ' },
      { title: 'x'.repeat(501) },
      { cli: 'gemini' as 'claude' },
    ];
    for (const over of bad) {
      const s = setup();
      const err = await refused(openWorker(s.ctx, spec(over), s.deps));
      expect(err.code, JSON.stringify(over).slice(0, 60)).toBe('INVALID');
      expect(err.message).not.toContain('rm -rf');
      expect(s.client.calls).toEqual([]);
    }
  });

  it('a title that breaks the title rule is INVALID before anything opens, never repeating it (Ruling P3-23)', async () => {
    for (const title of ['w --allowedTools Bash', 'x -y ; touch /tmp/p', 'Kason"s', 'a\nb', 'glob*']) {
      const s = setup();
      const err = await refused(openWorker(s.ctx, spec({ title }), s.deps));
      expect(err.code, title).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(title);
      expect(s.client.calls, title).toEqual([]);
      expect(s.workers.of(s.central.centralId), title).toEqual([]);
    }
  });

  it('a looser mode is refused', async () => {
    const cases: Array<[string | null, string]> = [
      ['default', 'acceptEdits'],
      ['default', 'bypassPermissions'],
      ['plan', 'default'],
      ['acceptEdits', 'auto'],
      ['auto', 'bypassPermissions'],
    ];
    for (const [centralMode, asked] of cases) {
      const s = setup({ centralMode });
      const err = await refused(openWorker(s.ctx, spec({ permissionMode: asked }), s.deps));
      expect(err.code, `${centralMode} → ${asked}`).toBe('DENIED');
      expect(s.client.calls).toEqual([]);
      expect(s.workers.of(s.central.centralId)).toEqual([]);
    }
    // As strict or stricter is fine, and with nothing asked a plan central's worker plans too.
    const strict = setup({ centralMode: 'auto' });
    await openWorker(strict.ctx, spec({ permissionMode: 'plan' }), strict.deps);
    expect(strict.posts('/terminals')[0].body).toMatchObject({ command: 'claude --permission-mode plan', permissionMode: 'plan' });
    const planner = setup({ centralMode: 'plan' });
    await openWorker(planner.ctx, spec(), planner.deps);
    expect(planner.posts('/terminals')[0].body).toMatchObject({ command: 'claude --permission-mode plan', permissionMode: 'plan' });
    // A mode the CLI does not know is not a mode.
    const odd = setup({ centralMode: 'bypassPermissions' });
    expect((await refused(openWorker(odd.ctx, spec({ permissionMode: 'yolo' }), odd.deps))).code).toBe('INVALID');
  });

  it('openWorker still refuses a looser mode (the cap is permissionCap.ts’s: the card, never the record)', async () => {
    // The record says bypass, the card says default: the card wins.
    const s = setup({ central: makeCentral('global', null, { terminalId: 'term-c', permissionMode: 'bypassPermissions' }), centralMode: 'default' });
    const err = await refused(openWorker(s.ctx, spec({ permissionMode: 'acceptEdits' }), s.deps));
    expect(err).toMatchObject({ code: 'DENIED', message: 'A central opens sessions no looser than its own permission mode.' });
    expect(s.client.calls).toEqual([]);
  });

  it('bypass only when the central bypasses', async () => {
    const bypasser = setup({ centralMode: 'bypassPermissions' });
    const w = await openWorker(bypasser.ctx, spec({ permissionMode: 'bypassPermissions' }), bypasser.deps);
    expect(bypasser.posts('/terminals')[0].body).toMatchObject({
      command: 'claude --dangerously-skip-permissions',
      permissionMode: 'bypassPermissions',
    });
    expect(w.permissionMode).toBe('bypassPermissions');
    // Nothing asked: the default, never the central's bypass.
    const quiet = setup({ centralMode: 'bypassPermissions' });
    await openWorker(quiet.ctx, spec(), quiet.deps);
    expect(quiet.posts('/terminals')[0].body).toMatchObject({ command: 'claude', permissionMode: 'default' });
    for (const centralMode of ['dontAsk', 'acceptEdits', null]) {
      const s = setup({ centralMode });
      expect((await refused(openWorker(s.ctx, spec({ permissionMode: 'bypassPermissions' }), s.deps))).code).toBe('DENIED');
    }
  });

  it("a Codex central's workers get no permission flag", async () => {
    const codexCentral = makeCentral('global', null, { cli: 'codex', terminalId: 'term-c' });
    const claude = setup({ central: codexCentral, centralMode: null });
    const w = await openWorker(claude.ctx, spec(), claude.deps);
    expect(claude.posts('/terminals')[0].body).toMatchObject({ command: 'claude', permissionMode: 'default' });
    expect(w.permissionMode).toBe('default');
    // Its card has no mode to cap by: anything looser than the default is refused.
    const looser = setup({ central: codexCentral, centralMode: null });
    expect((await refused(openWorker(looser.ctx, spec({ permissionMode: 'acceptEdits' }), looser.deps))).code).toBe('DENIED');

    const codex = setup({ central: codexCentral, centralMode: null });
    const cw = await openWorker(codex.ctx, spec({ cli: 'codex', effort: 'minimal' }), codex.deps);
    const body = codex.posts('/terminals')[0].body as Record<string, unknown>;
    expect(body.command).toBe('codex');
    expect(body).not.toHaveProperty('permissionMode');
    expect(body.effortLevel).toBe('minimal');
    expect(cw.permissionMode).toBeNull();
    // A Codex worker takes no permission mode in P4: asking for one is refused, not dropped.
    const asked = setup({ central: codexCentral, centralMode: null });
    expect((await refused(openWorker(asked.ctx, spec({ cli: 'codex', permissionMode: 'plan' }), asked.deps))).code).toBe('INVALID');
  });

  it('the 9th live worker is BUDGET', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const workers = createWorkerRegistry({ controller: () => null });
    const live: Session[] = [];
    for (let i = 1; i <= 8; i += 1) {
      // Opened long ago: the rolling minute is not what refuses.
      workers.add({ centralId: central.centralId, terminalId: `term-w${i}`, openedAt: NOW - 600_000, folder: KNOWN, cli: 'claude' });
      live.push(makeSession(`w${i}`, { terminalId: `term-w${i}`, status: 'waiting' }));
    }
    const full = setup({ central, workers, sessions: live });
    const err = await refused(openWorker(full.ctx, spec(), full.deps));
    expect(err.code).toBe('BUDGET');
    expect(full.client.calls).toEqual([]);

    // One of them ended: the ninth opens.
    const roomy = setup({ central, workers, sessions: [...live.slice(1), { ...live[0], status: 'ended' }] });
    await openWorker(roomy.ctx, spec(), roomy.deps);
    expect(roomy.posts('/terminals')).toHaveLength(1);
  });

  it('two opens at the 8th slot: one opens, one refused BUDGET', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const workers = createWorkerRegistry({ controller: () => null });
    const live: Session[] = [];
    for (let i = 1; i <= 7; i += 1) {
      workers.add({ centralId: central.centralId, terminalId: `term-w${i}`, openedAt: NOW - 600_000, folder: KNOWN, cli: 'claude' });
      live.push(makeSession(`w${i}`, { terminalId: `term-w${i}`, status: 'waiting' }));
    }
    const s = setup({ central, workers, sessions: live });

    const both = await Promise.allSettled([openWorker(s.ctx, spec(), s.deps), openWorker(s.ctx, spec(), s.deps)]);

    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refusal = both.find((r): r is PromiseRejectedResult => r.status === 'rejected')!.reason as ToolError;
    expect(refusal.code).toBe('BUDGET');
    expect(s.posts('/terminals')).toHaveLength(1);
  });

  it('a refused open gives its reserved slot back', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const workers = createWorkerRegistry({ controller: () => null });
    const live: Session[] = [];
    for (let i = 1; i <= 7; i += 1) {
      workers.add({ centralId: central.centralId, terminalId: `term-w${i}`, openedAt: NOW - 600_000, folder: KNOWN, cli: 'claude' });
      live.push(makeSession(`w${i}`, { terminalId: `term-w${i}`, status: 'waiting' }));
    }
    const s = setup({ central, workers, sessions: live, deps: { realpath: async () => Promise.reject(new Error('ENOENT')) } });
    expect((await refused(openWorker(s.ctx, spec(), s.deps))).code).toBe('INVALID');

    const next = setup({ central, workers, sessions: live });
    await openWorker(next.ctx, spec(), next.deps);
    expect(next.posts('/terminals')).toHaveLength(1);
  });

  it('the 11th open in a minute is BUDGET', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const workers = createWorkerRegistry({ controller: () => null });
    for (let i = 1; i <= 10; i += 1) {
      workers.add({ centralId: central.centralId, terminalId: `term-o${i}`, openedAt: NOW - 30_000, folder: KNOWN, cli: 'claude' });
      // Gone already: only the opens are counted, not who is live.
      workers.release(`term-o${i}`, 'exited');
    }
    const s = setup({ central, workers });
    expect((await refused(openWorker(s.ctx, spec(), s.deps))).code).toBe('BUDGET');
    expect(s.client.calls).toEqual([]);

    // A minute later the window has rolled on.
    const later = setup({ central, workers, deps: { now: () => NOW + 31_000 } });
    await openWorker(later.ctx, spec(), later.deps);
    expect(later.posts('/terminals')).toHaveLength(1);
  });

  it('a plan window over 90 % is BUDGET', async () => {
    const asked: string[] = [];
    const planWindowPct = (cli: 'claude' | 'codex'): number => {
      asked.push(cli);
      return 91;
    };
    const over = setup({ deps: { planWindowPct } });
    expect((await refused(openWorker(over.ctx, spec({ cli: 'codex' }), over.deps))).code).toBe('BUDGET');
    expect(asked).toEqual(['codex']);
    expect(over.client.calls).toEqual([]);
    for (const pct of [90, null]) {
      const s = setup({ deps: { planWindowPct: () => pct } });
      await openWorker(s.ctx, spec(), s.deps);
      expect(s.posts('/terminals'), String(pct)).toHaveLength(1);
    }
  });

  it('a project central cannot open outside its folder', async () => {
    const central = makeCentral('project', `${HOME}/proj`, { terminalId: 'term-c' });
    const outside = setup({ central });
    const err = await refused(openWorker(outside.ctx, spec({ folder: `${HOME}/other` }), outside.deps));
    expect(err.code).toBe('DENIED');
    expect(err.message).not.toContain('other');
    expect(outside.client.calls).toEqual([]);

    // A link inside its folder that leads out of it is judged by where it leads.
    const link = setup({ central, deps: { realpath: async (p) => (p.endsWith('/link') ? `${HOME}/other` : p) } });
    expect((await refused(openWorker(link.ctx, spec({ folder: `${HOME}/proj/link` }), link.deps))).code).toBe('DENIED');

    const below = setup({ central });
    const w = await openWorker(below.ctx, spec({ folder: `${HOME}/proj/web` }), below.deps);
    expect(w.folder).toBe(`${HOME}/proj/web`);
  });

  it('home, / and dot-folders are refused', async () => {
    for (const folder of [HOME, '/', '~', `${HOME}/.ssh`, `${HOME}/.config/tool`, '/etc', `${HOME}/proj/../.aws`]) {
      const s = setup();
      const err = await refused(openWorker(s.ctx, spec({ folder }), s.deps));
      expect(err.code, folder).toBe('DENIED');
      expect(s.client.calls).toEqual([]);
    }
    const relative = setup();
    expect((await refused(openWorker(relative.ctx, spec({ folder: 'proj' }), relative.deps))).code).toBe('INVALID');
    // A folder whose real path is a dot folder is refused as that.
    const link = setup({ deps: { realpath: async () => `${HOME}/.ssh` } });
    expect((await refused(openWorker(link.ctx, spec({ folder: `${HOME}/keys` }), link.deps))).code).toBe('DENIED');
    // A folder that is not there.
    const gone = setup({ deps: { realpath: async () => Promise.reject(new Error('ENOENT: /home/u/gone')) } });
    const err = await refused(openWorker(gone.ctx, spec({ folder: `${HOME}/gone` }), gone.deps));
    expect(err.code).toBe('INVALID');
    expect(err.message).not.toContain('gone');
  });

  it('an unknown folder sends autoConfirmTrust false', async () => {
    const unknown = setup();
    await openWorker(unknown.ctx, spec({ folder: `${HOME}/fresh` }), unknown.deps);
    expect(unknown.posts('/terminals')[0].body).toMatchObject({ workingDir: `${HOME}/fresh`, autoConfirmTrust: false });
    // `~` is the home it was handed.
    const tilde = setup();
    await openWorker(tilde.ctx, spec({ folder: '~/fresh' }), tilde.deps);
    expect(tilde.posts('/terminals')[0].body).toMatchObject({ workingDir: `${HOME}/fresh`, autoConfirmTrust: false });

    const known = setup();
    await openWorker(known.ctx, spec({ folder: KNOWN }), known.deps);
    expect(known.posts('/terminals')[0].body).not.toHaveProperty('autoConfirmTrust');
  });

  it('a worker being filed into its room is counted once', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const workers = createWorkerRegistry({ controller: () => null });
    const live: Session[] = [];
    for (let i = 1; i <= 6; i += 1) {
      workers.add({ centralId: central.centralId, terminalId: `term-w${i}`, openedAt: NOW - 600_000, folder: KNOWN, cli: 'claude' });
      live.push(makeSession(`w${i}`, { terminalId: `term-w${i}`, status: 'waiting' }));
    }
    let opens = 0;
    let finishFiling: (a: Answer) => void = () => undefined;
    const filing = new Promise<Answer>((resolve) => {
      finishFiling = resolve;
    });
    const s = setup({
      central,
      workers,
      sessions: live,
      rooms: [makeRoom('r1', [])],
      routes: {
        // Each open puts its card into the store, as the real route does.
        'POST /terminals': () => {
          opens += 1;
          const id = `term-new-${opens}`;
          s.sessions.push(makeSession(id, { terminalId: id, status: 'connecting' }));
          return ok({ ok: true, terminalId: id });
        },
        'POST /rooms/ops': () => filing as never,
      },
    });

    // A is open (7 live) and waiting on its room; its reservation is not also held against B.
    const a = openWorker(s.ctx, spec({ roomId: 'r1' }), s.deps);
    await vi.waitFor(() => expect(s.posts('/rooms/ops')).toHaveLength(1));
    const b = await openWorker(s.ctx, spec(), s.deps);
    expect(b.terminalId).toBe('term-new-2');

    finishFiling(filed() as never);
    expect((await a).terminalId).toBe('term-new-1');
    expect(s.workers.of(central.centralId)).toHaveLength(8);
  });

  it('no writer leaves it unfiled with a note', async () => {
    const rooms = [makeRoom('r1', []), makeRoom('r2', [])];
    const noWriter = setup({ rooms, routes: { 'POST /rooms/ops': fail(409, 'no-writer') } });
    const w = await openWorker(noWriter.ctx, spec({ roomId: 'r1' }), noWriter.deps);
    expect(noWriter.posts('/rooms/ops')[0].body).toEqual({ type: 'move', sessionId: NEW_TERMINAL, roomId: 'r1' });
    expect(w).toMatchObject({ roomId: 'r1', filed: false, note: ROOM_FILED_LATER });
    // What is true (Ruling P4-18): nothing files it later; it is the central's own worker, so in its scope.
    expect(ROOM_FILED_LATER).not.toMatch(/when the AASC window opens|later/);
    expect(ROOM_FILED_LATER).toMatch(/not in the room/);
    expect(ROOM_FILED_LATER).toMatch(/your own worker/);
    expect(ROOM_FILED_LATER).toMatch(/scope/);
    expect(noWriter.workers.of(noWriter.central.centralId)).toHaveLength(1);

    const writer = setup({ rooms });
    expect(await openWorker(writer.ctx, spec({ roomId: 'r2' }), writer.deps)).toMatchObject({ roomId: 'r2', filed: true, note: null });

    // Another failure leaves it open and unfiled, saying so in AASC's words.
    const broken = setup({ rooms, routes: { 'POST /rooms/ops': fail(500, 'boom at /home/u/known') } });
    const bw = await openWorker(broken.ctx, spec({ roomId: 'r1' }), broken.deps);
    expect(bw.filed).toBe(false);
    expect(bw.note).toMatch(/could not file/);
    expect(bw.note).not.toContain('boom');

    // A room that is not there: nothing opens.
    const missing = setup({ rooms });
    expect((await refused(openWorker(missing.ctx, spec({ roomId: 'r9' }), missing.deps))).code).toBe('NOT_FOUND');
    expect(missing.client.calls).toEqual([]);
  });

  it('a room central files into its own room only', async () => {
    const central = makeCentral('room', 'r1', { terminalId: 'term-c' });
    const rooms = [makeRoom('r1', ['card-central-1']), makeRoom('r2', [])];
    const own = setup({ central, rooms });
    const w = await openWorker(own.ctx, spec(), own.deps);
    expect(own.posts('/rooms/ops')[0].body).toEqual({ type: 'move', sessionId: NEW_TERMINAL, roomId: 'r1' });
    expect(w).toMatchObject({ roomId: 'r1', filed: true });
    // Its new worker is in its scope before any room holds it (workers.ts).
    expect(own.ctx.inScope(makeSession(NEW_TERMINAL, { terminalId: NEW_TERMINAL }))).toBe(true);

    const other = setup({ central, rooms });
    expect((await refused(openWorker(other.ctx, spec({ roomId: 'r2' }), other.deps))).code).toBe('DENIED');
    expect(other.client.calls).toEqual([]);
  });

  it('route 429 maps to BUDGET', async () => {
    const cases: Array<[Answer, string]> = [
      [fail(429, 'Too many sessions'), 'BUDGET'],
      [fail(400, 'Directory not found: /home/u/known'), 'INVALID'],
      [fail(403, 'nope'), 'DENIED'],
      [fail(409, 'taken'), 'DENIED'],
      [fail(500, 'Failed to create terminal'), 'UPSTREAM'],
      [{ ok: false, status: 0, data: null, error: 'fetch failed' }, 'UPSTREAM'],
      [ok({ ok: true, terminalId: 'card-old', deduplicated: true }), 'UPSTREAM'],
      [ok({ ok: true }), 'UPSTREAM'],
    ];
    for (const [answer, code] of cases) {
      const s = setup({ routes: { 'POST /terminals': answer } });
      const err = await refused(openWorker(s.ctx, spec(), s.deps));
      expect(err.code, `${answer.status} → ${code}`).toBe(code);
      expect(err.message).not.toMatch(/Directory not found|\/home\/u/);
      expect(s.workers.of(s.central.centralId)).toEqual([]);
    }
  });
});
