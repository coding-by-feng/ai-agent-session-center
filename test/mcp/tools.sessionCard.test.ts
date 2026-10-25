// test/mcp/tools.sessionCard.test.ts — the card setters of the sessions toolset (server/mcp/tools/sessionCard.ts, Task 8,
// Ruling P3-7): title, remark, pinned, muted, alerted, accent colour, character model, AI popup and sharing. Each one
// names its session through resolveTarget, passes the card rail (`ctx.mayEdit`: scope, the kinds, hands-off) and then
// calls its PUT route with the route's own body key. `session_set_shared` is the one `ask`: turning sharing ON asks the
// person (Ruling P3-6). Only the fake client answers here: nothing reaches a route or a process.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { allTools } from '../../server/mcp/registry.js';
import { fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = 's-card-1111';
const toolNamed = (name: string) => allTools().find((t) => t.name === name);

interface Case {
  tool: string;
  args: Record<string, unknown>;
  route: string;
  body: Record<string, unknown>;
  data: Record<string, unknown>;
  answer?: Record<string, unknown>;
}

const CASES: Case[] = [
  { tool: 'session_set_title', args: { title: 'New title' }, route: 'title', body: { title: 'New title' }, data: { title: 'New title' } },
  { tool: 'session_set_remark', args: { remark: 'half done' }, route: 'remark', body: { remark: 'half done' }, data: { remark: 'half done' } },
  { tool: 'session_set_pinned', args: { on: true }, route: 'pinned', body: { pinned: true }, data: { pinned: true } },
  { tool: 'session_set_muted', args: { on: false }, route: 'muted', body: { muted: false }, data: { muted: false } },
  { tool: 'session_set_alerted', args: { on: true }, route: 'alerted', body: { alerted: true }, data: { alerted: true } },
  { tool: 'session_set_accent_color', args: { color: '#00f0ff' }, route: 'accent-color', body: { color: '#00f0ff' }, data: { accentColor: '#00f0ff' } },
  { tool: 'session_set_character_model', args: { model: 'drone' }, route: 'character-model', body: { model: 'drone' }, data: { characterModel: 'drone' } },
  {
    tool: 'session_set_ai_popup',
    args: { on: false },
    route: 'ai-popup',
    body: { aiPopupEnabled: false },
    data: { aiPopup: false },
    answer: { ok: true, aiPopupEnabled: false },
  },
  {
    tool: 'session_set_shared',
    args: { on: true },
    route: 'remote-visible',
    body: { remoteVisible: true },
    data: { shared: true },
    answer: { success: true, remoteVisible: true },
  },
];

const SETTERS = CASES.map((c) => c.tool);

/** A world with one plain card, its route answering ok. */
function world(c: Case, over: Partial<Session> = {}) {
  const card = makeSession(ID, { cliSource: 'claude', ...over });
  return makeCtx({ sessions: [card], routes: { [`PUT /sessions/${ID}/${c.route}`]: ok(c.answer ?? { ok: true }) } });
}

describe('card setters: happy paths', () => {
  for (const c of CASES) {
    it(`${c.tool} calls PUT …/${c.route} with the route’s own body`, async () => {
      const h = world(c);

      const result = await run(c.tool, { id: ID, ...c.args }, h.ctx);

      expect(h.client.calls).toEqual([{ method: 'PUT', path: `/sessions/${ID}/${c.route}`, body: c.body }]);
      expect(result.data).toEqual({ sessionId: ID, ...c.data });
      expect(result.summary).toContain('s-card-1');
      expect(result.activity).toEqual([expect.objectContaining({ targetSessionId: ID })]);
      // The words of the summary and the activity row never repeat what the central wrote.
      if (typeof c.args.title === 'string') expect(result.summary).not.toContain(c.args.title);
      if (typeof c.args.remark === 'string') expect(JSON.stringify(result.activity)).not.toContain(c.args.remark);
    });
  }

  it('the setters are phase-3 idempotent writes of the sessions toolset; only set_shared asks', () => {
    for (const name of SETTERS) {
      const tool = toolNamed(name);
      expect(tool, name).toMatchObject({ toolset: 'sessions', phase: 3, idempotent: true });
      expect(tool?.risk, name).toBe(name === 'session_set_shared' ? 'ask' : 'write');
      expect(typeof tool?.confirm === 'function', name).toBe(name === 'session_set_shared');
    }
  });

  it('a remark may be empty (it clears the remark), a title may not', async () => {
    const remark = CASES[1];
    const h = world(remark);
    await run('session_set_remark', { id: ID, remark: '' }, h.ctx);
    expect(h.client.calls[0].body).toEqual({ remark: '' });
    await expect(run('session_set_title', { id: ID, title: '' }, h.ctx)).rejects.toThrow(/Arguments refused/);
  });

  it('the inputs mirror the routes’ limits: title 500, remark 200, a #hex colour, the character-model list', async () => {
    const h = world(CASES[0]);
    await expect(run('session_set_title', { id: ID, title: 'x'.repeat(501) }, h.ctx)).rejects.toThrow(/Arguments refused/);
    await expect(run('session_set_remark', { id: ID, remark: 'x'.repeat(201) }, h.ctx)).rejects.toThrow(/Arguments refused/);
    await expect(run('session_set_accent_color', { id: ID, color: 'red; background:url(x)' }, h.ctx)).rejects.toThrow(/Arguments refused/);
    await expect(run('session_set_character_model', { id: ID, model: 'dragon' }, h.ctx)).rejects.toThrow(/Arguments refused/);
    expect(h.client.calls).toEqual([]);
  });

  it('a title that breaks the title rule is INVALID and calls no route (Ruling P3-23)', async () => {
    for (const title of ['x -y ; touch /tmp/p', 'w --allowedTools Bash', '$(id)', 'two\nlines', "Kason's"]) {
      const h = world(CASES[0]);
      const err = await runRefused('session_set_title', { id: ID, title }, h.ctx);
      expect(err.code, title).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(title);
      expect(h.client.calls, title).toEqual([]);
    }
    expect(toolNamed('session_set_title')?.description).toContain('no word starting with a dash');
  });

  it('a route’s refusal is the route’s refusal', async () => {
    const card = makeSession(ID, { cliSource: 'claude' });
    const h = makeCtx({ sessions: [card], routes: { [`PUT /sessions/${ID}/ai-popup`]: fail(404, 'Session not found') } });
    expect((await runRefused('session_set_ai_popup', { id: ID, on: true }, h.ctx)).code).toBe('NOT_FOUND');
  });
});

describe('card setters: the rail', () => {
  it('each setter refuses another central’s card and a hands-off card', async () => {
    for (const c of CASES) {
      const other = world(c, { central: { centralId: 'central-2', kind: 'room', scopeRef: 'r1' } });
      const refusedOther = await runRefused(c.tool, { id: ID, ...c.args }, other.ctx);
      expect(refusedOther.code, c.tool).toBe('INVALID');
      expect(refusedOther.message).toContain('another central');

      const away = world(c, { handsOff: true });
      expect((await runRefused(c.tool, { id: ID, ...c.args }, away.ctx)).code, c.tool).toBe('HANDS_OFF');

      expect(other.client.calls, c.tool).toEqual([]);
      expect(away.client.calls, c.tool).toEqual([]);
    }
  });

  it('a central’s own card is refused too', async () => {
    const central = makeCentral('global', null, { terminalId: 'term-c' });
    const own = makeSession(ID, { terminalId: 'term-c', central: { centralId: central.centralId, kind: 'global', scopeRef: null } });
    const h = makeCtx({ central, sessions: [own], routes: { [`PUT /sessions/${ID}/title`]: ok({ ok: true }) } });
    const err = await runRefused('session_set_title', { id: ID, title: 'mine' }, h.ctx);
    expect(err.code).toBe('INVALID');
    expect(h.client.calls).toEqual([]);
  });

  it('an out-of-scope id is NOT_IN_SCOPE and calls no route', async () => {
    const central = makeCentral('room', 'r1');
    for (const c of CASES) {
      const card = makeSession(ID, { cliSource: 'claude' });
      const h = makeCtx({ central, sessions: [card], rooms: [makeRoom('r1', []), makeRoom('r2', [ID])] });
      const err = await runRefused(c.tool, { id: ID, ...c.args }, h.ctx);
      expect(err.code, c.tool).toBe('NOT_IN_SCOPE');
      expect(h.client.calls, c.tool).toEqual([]);
      if (c.tool === 'session_set_shared') {
        const tool = toolNamed(c.tool);
        await expect(Promise.resolve().then(() => tool?.confirm?.({ id: ID, on: true }, h.ctx))).rejects.toMatchObject({ code: 'NOT_IN_SCOPE' });
      }
    }
  });

  it('an ended card, or one with no terminal, may still be written (nothing is typed)', async () => {
    const h = world(CASES[0], { status: 'ended', terminalId: null });
    await run('session_set_title', { id: ID, title: 'Done' }, h.ctx);
    expect(h.client.calls).toHaveLength(1);
  });
});

describe('session_set_shared', () => {
  const tool = () => {
    const t = toolNamed('session_set_shared');
    if (t?.confirm === undefined) throw new Error('session_set_shared has no confirm');
    return t as Required<Pick<NonNullable<typeof t>, 'confirm'>> & NonNullable<typeof t>;
  };

  it('set_shared on asks with the session’s short id and no title in the summary', async () => {
    const h = world(CASES[8], { title: 'Secret project title' });

    const ask = await tool().confirm({ id: ID, on: true }, h.ctx);

    expect(ask).toEqual({ summary: 'share session s-card-1 with your paired phone', targetSessionId: ID });
    expect(JSON.stringify(ask)).not.toContain('Secret');
    expect(h.client.calls).toEqual([]);
  });

  it('set_shared off calls the route without a card', async () => {
    const h = world(CASES[8], { remoteVisible: true });

    expect(await tool().confirm({ id: ID, on: false }, h.ctx)).toBeNull();
    const result = await run('session_set_shared', { id: ID, on: false }, h.ctx);

    expect(h.client.calls).toEqual([{ method: 'PUT', path: `/sessions/${ID}/remote-visible`, body: { remoteVisible: false } }]);
    expect(result.data).toEqual({ sessionId: ID, shared: false });
  });

  it('a card that is already shared needs no card to be shared again', async () => {
    const h = world(CASES[8], { remoteVisible: true });
    expect(await tool().confirm({ id: ID, on: true }, h.ctx)).toBeNull();
  });

  it('a hands-off card is refused before any card opens', async () => {
    const h = world(CASES[8], { handsOff: true });
    await expect(Promise.resolve().then(() => tool().confirm({ id: ID, on: true }, h.ctx))).rejects.toMatchObject({ code: 'HANDS_OFF' });
  });
});

describe('descriptions', () => {
  it('descriptions name the rule they apply (hands-off, another central)', () => {
    for (const name of SETTERS) {
      const d = toolNamed(name)?.description ?? '';
      expect(d, name).toContain('hands-off');
      expect(d, name).toContain('another central');
    }
    expect(toolNamed('session_set_shared')?.description).toContain('asks the person');
  });
});
