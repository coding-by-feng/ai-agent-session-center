// test/mcp/tools.sessionModel.test.ts — `session_set_model` and `session_set_effort` (server/mcp/tools/sessionCard.ts,
// Task 9, Ruling P3-17): they type `/model <m>` or `/effort <e>` into a session the way command_run types a safe
// built-in with its choice, through the prompt route and the full steering rails. Only the fake client answers here.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { allTools } from '../../server/mcp/registry.js';
import { fail, makeCtx, makeSession, NOW, ok, run, runRefused, unheard, type CtxOptions } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = 's-model-111';
const PROMPT = `POST /sessions/${ID}/prompt`;

function world(over: Partial<Session> = {}, opts: Partial<CtxOptions> = {}) {
  const card = makeSession(ID, { cliSource: 'claude', terminalId: 'term-m1', ...over });
  return makeCtx({ sessions: [card], routes: { [PROMPT]: ok({ ok: true, key: 'k' }, 202) }, ...opts });
}

const prompts = (h: ReturnType<typeof world>) => h.client.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/prompt'));

describe('session_set_model', () => {
  it('types /model sonnet through the prompt route', async () => {
    const h = world();

    const result = await run('session_set_model', { id: ID, model: 'sonnet' }, h.ctx);

    const [call] = prompts(h);
    expect(call.body).toMatchObject({ text: '/model sonnet', mode: 'now' });
    expect((call.body as { key: string }).key).toMatch(/^mcp-central_-\d+$/);
    expect(result.data).toMatchObject({ sessionId: ID, model: 'sonnet', accepted: true, code: null });
    expect(result.summary).toContain('s-model-');
    expect(result.activity).toEqual([expect.objectContaining({ targetSessionId: ID })]);
  });

  it('is a phase-3 steer of the sessions toolset whose description names the rails', () => {
    for (const name of ['session_set_model', 'session_set_effort']) {
      const tool = allTools().find((t) => t.name === name);
      expect(tool, name).toMatchObject({ toolset: 'sessions', risk: 'steers', phase: 3 });
      expect(tool?.description, name).toContain('hands-off');
      expect(tool?.confirm, name).toBeUndefined();
    }
  });
});

describe('session_set_effort', () => {
  it('types /effort high into a Claude session and /effort minimal into a Codex one', async () => {
    const claude = world();
    await run('session_set_effort', { id: ID, effort: 'high' }, claude.ctx);
    expect(prompts(claude)[0].body).toMatchObject({ text: '/effort high' });

    const codex = world({ cliSource: 'codex' });
    const result = await run('session_set_effort', { id: ID, effort: 'minimal' }, codex.ctx);
    expect(prompts(codex)[0].body).toMatchObject({ text: '/effort minimal' });
    expect(result.data).toMatchObject({ sessionId: ID, effort: 'minimal', accepted: true });
  });
});

describe('refusals', () => {
  it('a bad model or an effort the CLI lacks is INVALID and types nothing', async () => {
    const h = world();
    for (const model of ['son net', 'x;y', '/clear', 'sonnet\r/exit']) {
      const err = await runRefused('session_set_model', { id: ID, model }, h.ctx);
      expect(err.code, model).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(model);
    }
    await expect(run('session_set_model', { id: ID, model: 'a'.repeat(101) }, h.ctx)).rejects.toThrow(/Arguments refused/);
    expect((await runRefused('session_set_effort', { id: ID, effort: 'minimal' }, h.ctx)).code).toBe('INVALID');
    const codex = world({ cliSource: 'codex' });
    expect((await runRefused('session_set_effort', { id: ID, effort: 'ultracode' }, codex.ctx)).code).toBe('INVALID');
    const unknown = world({ cliSource: 'gemini' as Session['cliSource'] });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, unknown.ctx)).code).toBe('INVALID');
    expect(prompts(h)).toEqual([]);
    expect(prompts(codex)).toEqual([]);
    expect(prompts(unknown)).toEqual([]);
  });

  it('the steering rails apply (hands-off, 60 s, BUSY)', async () => {
    const away = world({ handsOff: true });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, away.ctx)).code).toBe('HANDS_OFF');

    const person = world({}, { controller: () => ({ clientId: 'browser-1', lastActivityAt: NOW - 5_000 }) });
    expect((await runRefused('session_set_effort', { id: ID, effort: 'high' }, person.ctx)).code).toBe('HUMAN_ACTIVE');

    const locked = world({}, { ledger: { ...unwiredLedger, isLocked: () => true } });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, locked.ctx)).code).toBe('BUSY');

    const busyRoute = world();
    const busy = makeCtx({
      sessions: busyRoute.sessions,
      routes: { [PROMPT]: { ...fail(409, 'busy'), data: { code: 'busy', error: 'busy' } } },
    });
    const result = await run('session_set_model', { id: ID, model: 'sonnet' }, busy.ctx);
    expect(result.data).toMatchObject({ accepted: false, code: 'BUSY', reason: 'busy' });

    for (const h of [away, person, locked]) expect(prompts(h)).toEqual([]);
  });

  it('a never-started card is refused (the route’s not_started reaches data)', async () => {
    const card = unheard(makeSession(ID, { cliSource: 'claude', terminalId: 'term-m2' }));
    const h = makeCtx({
      sessions: [card],
      routes: { [PROMPT]: { ...fail(409, 'not started'), data: { code: 'not_started', error: 'not started' } } },
    });

    const result = await run('session_set_effort', { id: ID, effort: 'high' }, h.ctx);

    expect(result.data).toMatchObject({ sessionId: ID, accepted: false, code: 'UNAVAILABLE', reason: 'not_started' });
    expect(result.summary).toContain('Not sent');
  });

  it('an ended card or another central is refused before anything is typed', async () => {
    const ended = world({ status: 'ended' });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, ended.ctx)).code).toBe('INVALID');
    const other = world({ central: { centralId: 'central-9', kind: 'global', scopeRef: null } });
    expect((await runRefused('session_set_model', { id: ID, model: 'sonnet' }, other.ctx)).code).toBe('INVALID');
    expect(prompts(ended)).toEqual([]);
    expect(prompts(other)).toEqual([]);
  });
});
