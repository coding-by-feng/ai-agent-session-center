// test/mcp/tools.sessionModel.test.ts — `session_set_model` / `session_set_effort` (server/mcp/tools/sessionCard.ts)
// and `central_set_runtime` (tools/centralRuntime.ts). Since Nov 23 2026 a change goes through the change box
// (runtimeChange.ts): typed once the session is free, and answered "confirmed" only when the CLI recorded it.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { allTools } from '../../server/mcp/registry.js';
import { createRuntimeChangeBox, type RuntimeChangeBox } from '../../server/mcp/runtimeChange.js';
import type { PromptRequest } from '../../server/promptSubmit.js';
import { makeCentral, makeCtx, makeSession, NOW, run, runRefused, type CtxOptions } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = 's-model-111';
const CENTRAL_CARD = 's-central-999';

interface Rig {
  box: RuntimeChangeBox;
  typed: PromptRequest[];
  sessions: Session[];
}

/** A change box over `sessions`; the CLI "records" whatever is typed when `records` is on. */
function rig(sessions: Session[], records = true): Rig {
  const typed: PromptRequest[] = [];
  const box = createRuntimeChangeBox({
    sessions: () => sessions,
    controller: () => null,
    hasRoom: () => true,
    submit: async (req) => {
      typed.push(req);
      if (records) {
        const i = sessions.findIndex((s) => s.terminalId === req.terminalId);
        const [cmd, value] = req.text.slice(1).split(' ');
        const rt = cmd === 'model'
          ? { launchModel: value, launchModelAt: NOW, model: value, modelAt: NOW }
          : { effort: value, effortAt: NOW, effortSet: true };
        sessions[i] = { ...sessions[i], runtime: { ...sessions[i].runtime, ...rt } };
      }
      return { outcome: 'unconfirmed', typed: true };
    },
    now: () => NOW,
    manual: true,
  });
  return { box, typed, sessions };
}

function world(over: Partial<Session> = {}, opts: Partial<CtxOptions> = {}, records = true) {
  const card = makeSession(ID, { cliSource: 'claude', terminalId: 'term-m1', status: 'waiting', ...over });
  const own = makeSession(CENTRAL_CARD, {
    cliSource: 'claude',
    terminalId: 'term-central',
    status: 'working',
    central: { centralId: 'central-1', kind: 'global', scopeRef: null },
  });
  const r = rig([card, own], records);
  const h = makeCtx({ sessions: r.sessions, settings: r.box, central: makeCentral(), centrals: [makeCentral()], ...opts });
  return { ...h, ...r };
}

/** Runs a tool while ticking the box, as its timer would. */
async function runTicking(name: string, args: Record<string, unknown>, w: ReturnType<typeof world>) {
  let settled = false;
  const p = run(name, args, w.ctx).finally(() => {
    settled = true;
  });
  for (let i = 0; i < 20 && !settled; i += 1) {
    await w.box.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  return p;
}

const changesOf = (data: unknown) => (data as { changes: Array<{ state: string; kind: string; value: string }> }).changes;

describe('session_set_model / session_set_effort', () => {
  it('types /model sonnet into a free session and answers confirmed once the CLI recorded it', async () => {
    const w = world();
    const result = await runTicking('session_set_model', { id: ID, model: 'sonnet' }, w);
    expect(w.typed.map((t) => t.text)).toEqual(['/model sonnet']);
    expect(changesOf(result.data)).toEqual([expect.objectContaining({ kind: 'model', value: 'sonnet', state: 'confirmed' })]);
    expect(result.summary).toContain('Confirmed');
    expect(result.summary).not.toContain('Do not tell the person it is done');
  });

  it('a busy session is not typed into: the answer says scheduled and not done', async () => {
    const w = world({ status: 'working' });
    const result = await run('session_set_effort', { id: ID, effort: 'high' }, w.ctx);
    await w.box.tick();
    expect(w.typed).toEqual([]);
    expect(changesOf(result.data)[0].state).toBe('waiting');
    expect(result.summary).toMatch(/Scheduled: .*once it is free/);
    expect(result.summary).toContain('Do not tell the person it is done');
  });

  it('typed but not recorded yet is not called done (Codex reports it at its next turn)', async () => {
    const ac = new AbortController();
    const w = world({ cliSource: 'codex' }, { signal: ac.signal }, false);
    const pending = run('session_set_effort', { id: ID, effort: 'minimal' }, w.ctx);
    for (let i = 0; i < 10 && w.typed.length === 0; i += 1) {
      await w.box.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(w.typed.map((t) => t.text)).toEqual(['/effort minimal']);
    ac.abort();
    const result = await pending;
    expect(changesOf(result.data)[0].state).toBe('typed');
    expect(result.summary).toContain('next turn');
    expect(result.summary).toContain('Do not tell the person it is done');
  });

  it('is a phase-3 steer of the sessions toolset whose description names the rails', () => {
    for (const name of ['session_set_model', 'session_set_effort']) {
      const tool = allTools().find((t) => t.name === name);
      expect(tool, name).toMatchObject({ toolset: 'sessions', risk: 'steers', phase: 3 });
      expect(tool?.description, name).toContain('hands-off');
      expect(tool?.description, name).toContain('central_set_runtime');
      expect(tool?.confirm, name).toBeUndefined();
    }
  });
});

describe('refusals before anything is scheduled', () => {
  it('a bad model or an effort the CLI lacks is INVALID and types nothing', async () => {
    const w = world();
    for (const model of ['son net', 'x;y', '/clear', 'sonnet\r/exit']) {
      const err = await runRefused('session_set_model', { id: ID, model }, w.ctx);
      expect(err.code, model).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(model);
    }
    await expect(run('session_set_model', { id: ID, model: 'a'.repeat(101) }, w.ctx)).rejects.toThrow(/Arguments refused/);
    expect((await runRefused('session_set_effort', { id: ID, effort: 'minimal' }, w.ctx)).code).toBe('INVALID');
    const codex = world({ cliSource: 'codex' });
    expect((await runRefused('session_set_effort', { id: ID, effort: 'ultracode' }, codex.ctx)).code).toBe('INVALID');
    const unknown = world({ cliSource: 'gemini' as Session['cliSource'] });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, unknown.ctx)).code).toBe('INVALID');
    for (const h of [w, codex, unknown]) {
      await h.box.tick();
      expect(h.typed).toEqual([]);
    }
  });

  it('the steering rails apply (hands-off, 60 s, BUSY)', async () => {
    const away = world({ handsOff: true });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, away.ctx)).code).toBe('HANDS_OFF');

    const person = world({}, { controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 5_000 }) });
    expect((await runRefused('session_set_effort', { id: ID, effort: 'high' }, person.ctx)).code).toBe('HUMAN_ACTIVE');

    const locked = world({}, { ledger: { ...unwiredLedger, isLocked: () => true } });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, locked.ctx)).code).toBe('BUSY');

    for (const h of [away, person, locked]) {
      await h.box.tick();
      expect(h.typed).toEqual([]);
    }
  });

  it('an ended card, another central, or the caller itself is refused; itself points to central_set_runtime', async () => {
    const ended = world({ status: 'ended' });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, ended.ctx)).code).toBe('INVALID');
    const other = world({ central: { centralId: 'central-9', kind: 'global', scopeRef: null } });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, other.ctx)).code).toBe('INVALID');
    const self = world();
    const err = await runRefused('session_set_effort', { id: CENTRAL_CARD, effort: 'low' }, self.ctx);
    expect(err).toMatchObject({ code: 'INVALID' });
    expect(err.hint).toContain('central_set_runtime');
  });

  it('a server without the change box answers UNAVAILABLE', async () => {
    const card = makeSession(ID, { cliSource: 'claude', terminalId: 'term-m1', status: 'waiting' });
    const h = makeCtx({ sessions: [card] });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, h.ctx)).code).toBe('UNAVAILABLE');
  });
});

describe('central_set_runtime', () => {
  it('is an ask of the system toolset: the person allows it first', () => {
    const tool = allTools().find((t) => t.name === 'central_set_runtime');
    expect(tool).toMatchObject({ toolset: 'system', risk: 'ask', phase: 3 });
    expect(typeof tool?.confirm).toBe('function');
  });

  it('asks about its own card with the exact commands, model before effort', async () => {
    const w = world();
    const tool = allTools().find((t) => t.name === 'central_set_runtime')!;
    const ask = await tool.confirm!({ effort: 'low', model: 'opus' }, w.ctx);
    expect(ask).toMatchObject({ summary: 'change this central to /model opus then /effort low', targetSessionId: CENTRAL_CARD });
    expect(ask?.fingerprint).toContain('term-central');
  });

  it('schedules for after the reply: nothing is typed while its own turn runs, and the answer is not "done"', async () => {
    const w = world();
    const result = await run('central_set_runtime', { model: 'opus', effort: 'low' }, w.ctx);
    expect(changesOf(result.data).map((c) => [c.kind, c.value, c.state])).toEqual([
      ['model', 'opus', 'waiting'],
      ['effort', 'low', 'waiting'],
    ]);
    expect(result.summary).toContain('once this reply has ended');
    expect(result.summary).toContain('Do not tell the person it is done');
    await w.box.tick();
    expect(w.typed).toEqual([]);

    // The reply ends: the central's card goes waiting, settled. Model first, then effort once the model is recorded.
    const i = w.sessions.findIndex((s) => s.sessionId === CENTRAL_CARD);
    w.sessions[i] = { ...w.sessions[i], status: 'waiting', lastActivityAt: NOW - 10_000 };
    await w.box.tick();
    expect(w.typed.map((t) => [t.terminalId, t.text])).toEqual([['term-central', '/model opus']]);
    await w.box.tick();
    await w.box.tick();
    expect(w.typed.map((t) => t.text)).toEqual(['/model opus', '/effort low']);
  });

  it('refuses a bad value, no value, and a central whose own card is gone', async () => {
    const w = world();
    expect((await runRefused('central_set_runtime', {}, w.ctx)).code).toBe('INVALID');
    expect((await runRefused('central_set_runtime', { model: 'x y' }, w.ctx)).code).toBe('INVALID');
    expect((await runRefused('central_set_runtime', { effort: 'minimal' }, w.ctx)).code).toBe('INVALID');
    const gone = world({}, { central: makeCentral('global', null, { terminalId: 'term-other' }) });
    expect((await runRefused('central_set_runtime', { effort: 'low' }, gone.ctx)).code).toBe('UNAVAILABLE');
  });

  it('a central marked hands-off before its reply ends is not typed into', async () => {
    const w = world();
    const result = await run('central_set_runtime', { effort: 'low' }, w.ctx);
    const i = w.sessions.findIndex((s) => s.sessionId === CENTRAL_CARD);
    w.sessions[i] = { ...w.sessions[i], status: 'waiting', lastActivityAt: NOW - 10_000, handsOff: true };
    await w.box.tick();
    expect(w.typed).toEqual([]);
    const id = (result.data as { changes: Array<{ changeId: string }> }).changes[0].changeId;
    expect(w.box.get(id)).toMatchObject({ state: 'not-applied', reason: 'the person marked the central hands-off' });
  });
});
