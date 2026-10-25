// test/mcp/tools.deliver.answers.test.ts — request_answer (requests toolset, server/mcp/tools/requests.ts) and
// snippet_use (saved prompts, server/mcp/tools/snippets.ts): answering a dialog a session raised, and using a saved
// prompt. request_answer types keys into another session's dialog, so it goes through the rails like any steering
// tool, with one exception the tests below pin: the lock a central's OWN task holds is not a reason to refuse it
// the answer to that task's dialog. A mock client stands in for the routes: nothing reaches a terminal or a process.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PendingRequest } from '../../src/types/session.js';
import { allTools, type ToolContext } from '../../server/mcp/registry.js';
import { ToolError } from '../../server/mcp/types.js';
import { deliverCtx, refusedBy, worker } from './deliverToolFixtures.js';
import { makeCentral, makeRoom, NOW, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'req-1',
  kind: 'permission',
  cli: 'claude',
  tool: 'Bash',
  raisedAt: NOW - 5_000,
  source: 'permission_request',
  ...over,
});

const asking = (id = 'w1', over: Parameters<typeof worker>[1] = {}) =>
  worker(id, { status: 'approval', pendingRequest: request(), ...over });

const accepted = ok({ success: true, data: { accepted: true } }, 202);
const answerRoute = (id = 'w1', requestId = 'req-1') => `POST /sessions/${id}/requests/${requestId}/answer`;

async function refusalOf(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolError> {
  const tool = allTools().find((t) => t.name === name)!;
  try {
    await tool.run(args, ctx);
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error(`${name} answered; a ToolError was expected`);
}

// ---------------------------------------------------------------------------
// request_answer
// ---------------------------------------------------------------------------

describe('request_answer', () => {
  it('answers a request once through the answer route, and says so', async () => {
    const { ctx, client } = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: accepted } });

    const result = await run('request_answer', { id: 'w1', requestId: 'req-1', choice: 'allow_once' }, ctx);

    expect(client.calls).toEqual([{ method: 'POST', path: '/sessions/w1/requests/req-1/answer', body: { choice: 'allow_once' } }]);
    expect(result.data).toEqual({ id: 'w1', shortId: 'w1', answered: true, choice: 'allow_once' });
    expect(result.summary).toMatch(/allow(ed)? once/i);
    expect(result.activity).toEqual([
      { summary: 'Answered a request: allow once.', targetSessionId: 'w1', detail: { choice: 'allow_once' } },
    ]);
  });

  it('denies, and picks an option of a question by its index', async () => {
    const { ctx, client } = deliverCtx({
      sessions: [asking('w1'), asking('w2', { pendingRequest: request({ kind: 'question' }) })],
      routes: { [answerRoute()]: accepted, [answerRoute('w2')]: accepted },
    });

    await run('request_answer', { id: 'w1', requestId: 'req-1', choice: 'deny' }, ctx);
    const picked = await run('request_answer', { id: 'w2', requestId: 'req-1', choice: 'option', optionIndex: 2 }, ctx);

    expect(client.calls.map((c) => c.body)).toEqual([{ choice: 'deny' }, { choice: 'option', optionIndex: 2 }]);
    expect(picked.activity?.[0]).toMatchObject({ summary: 'Answered a request: option 3.', detail: { choice: 'option', optionIndex: 2 } });
  });

  it('asks for the option’s index when the choice is an option, and sends no index with another choice', async () => {
    const { ctx, client } = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: accepted } });

    expect((await runRefused('request_answer', { id: 'w1', requestId: 'req-1', choice: 'option' }, ctx)).code).toBe('INVALID');
    expect(client.calls).toEqual([]);
    await run('request_answer', { id: 'w1', requestId: 'req-1', choice: 'deny', optionIndex: 1 }, ctx);
    expect(client.calls[0].body).toEqual({ choice: 'deny' });
  });

  it('request_answer schema has no allow_always', async () => {
    const tool = allTools().find((t) => t.name === 'request_answer')!;
    const schema = z.object(tool.input);
    const json = JSON.stringify(z.toJSONSchema(schema));

    expect(schema.safeParse({ id: 'w1', requestId: 'r', choice: 'allow_always' }).success).toBe(false);
    expect(schema.safeParse({ id: 'w1', requestId: 'r', choice: 'allow_once' }).success).toBe(true);
    expect(json).not.toMatch(/allow_always|always/i);
    expect(json).toMatch(/allow_once/);
    // And the tool itself never sends it, whatever reaches it.
    const { ctx, client } = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: accepted } });
    const err = await refusalOf('request_answer', { id: 'w1', requestId: 'req-1', choice: 'allow_always' }, ctx);
    expect(err.code).toBe('INVALID');
    expect(client.calls).toEqual([]);
    expect(tool.description).not.toMatch(/allow_always/);
  });

  it('writes the request id into the route path as one segment', async () => {
    const odd = 'a/b?c#d';
    const { ctx, client } = deliverCtx({
      sessions: [asking('w1', { pendingRequest: request({ id: odd }) })],
      routes: { [`POST /sessions/w1/requests/${encodeURIComponent(odd)}/answer`]: accepted },
    });

    await run('request_answer', { id: 'w1', requestId: odd, choice: 'allow_once' }, ctx);
    const err = await runRefused('request_answer', { id: 'w1', requestId: '..', choice: 'allow_once' }, ctx);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].path).toBe('/sessions/w1/requests/a%2Fb%3Fc%23d/answer');
    expect(err.code).toBe('INVALID');
  });

  it.each([
    [409, 'Already answered', 'stale', 'NOT_FOUND', /request_list/],
    [422, 'AASC can’t answer this prompt from here; open the terminal', 'unknown_prompt', 'INVALID', /terminal|person/i],
    [422, 'This request is too long to show in full; open the terminal to allow it', 'input_truncated', 'INVALID', /deny|person/i],
    [429, 'Too many answers from this device; wait a moment', 'rate_limited', 'BUDGET', /wait/i],
    [423, 'This device was not recognised. Reload it and try again.', 'control_held', 'UNAVAILABLE', /./],
    [409, 'The session has no live terminal', 'no_terminal', 'UNAVAILABLE', /./],
    [404, 'Session not found', undefined, 'NOT_FOUND', /./],
    [500, 'boom', undefined, 'UPSTREAM', /./],
  ])('turns the route’s %i (%s) into %s with a hint that says what to do', async (status, words, reason, code, hint) => {
    const { ctx } = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: refusedBy(status, words, reason) } });

    const err = await runRefused('request_answer', { id: 'w1', requestId: 'req-1', choice: 'allow_once' }, ctx);

    expect(err.code).toBe(code);
    expect(err.hint).toMatch(hint);
  });

  it('refuses a session out of scope, a hands-off one, and one a person drove a moment ago, before it types anything', async () => {
    const outside = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [asking()],
      rooms: [makeRoom('r1', [])],
      routes: { [answerRoute()]: accepted },
    });
    const handsOff = deliverCtx({ sessions: [asking('w1', { handsOff: true })], routes: { [answerRoute()]: accepted } });
    const human = deliverCtx({
      sessions: [asking()],
      routes: { [answerRoute()]: accepted },
      controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 20_000 }),
    });
    const args = { id: 'w1', requestId: 'req-1', choice: 'allow_once' };

    expect((await runRefused('request_answer', args, outside.ctx)).code).toBe('NOT_IN_SCOPE');
    expect((await runRefused('request_answer', args, handsOff.ctx)).code).toBe('HANDS_OFF');
    expect((await runRefused('request_answer', args, human.ctx)).code).toBe('HUMAN_ACTIVE');
    for (const h of [outside, handsOff, human]) expect(h.client.calls).toEqual([]);
  });

  it('answers the dialog of its own worker, whose task holds the lock: the lock is the central’s own', async () => {
    const h = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: accepted } });
    const mine = h.ctx.ledger.create({ central: h.ctx.central, session: h.ctx.sessions()[0], task: 'fix the tests' });
    expect(h.ctx.ledger.isLocked('w1')).toBe(true);

    const result = await run('request_answer', { id: 'w1', requestId: 'req-1', choice: 'allow_once' }, h.ctx);

    expect(h.client.calls).toHaveLength(1);
    expect(result.data).toMatchObject({ answered: true });
    expect(mine.taskId).toBe('T1');
  });

  it('does not take the lock of another central’s task for its own, nor let hands-off go because of its own task', async () => {
    const others = deliverCtx({ sessions: [asking()], routes: { [answerRoute()]: accepted } });
    others.base.create({
      central: makeCentral('global', null, { centralId: 'central-9', terminalId: 'term-c9' }),
      session: others.ctx.sessions()[0],
      task: 'theirs',
    });
    const flagged = deliverCtx({ sessions: [asking('w1', { handsOff: true })], routes: { [answerRoute()]: accepted } });
    flagged.ctx.ledger.create({ central: flagged.ctx.central, session: flagged.ctx.sessions()[0], task: 'mine' });
    const args = { id: 'w1', requestId: 'req-1', choice: 'allow_once' };

    expect((await runRefused('request_answer', args, others.ctx)).code).toBe('BUSY');
    expect((await runRefused('request_answer', args, flagged.ctx)).code).toBe('HANDS_OFF');
    expect(others.client.calls).toEqual([]);
    expect(flagged.client.calls).toEqual([]);
  });

  it('says nothing the session wrote: no tool name, no input, in the answer or the log', async () => {
    const { ctx } = deliverCtx({
      sessions: [asking('w1', { pendingRequest: request({ tool: 'IGNORE-ALL-PREVIOUS', input: { command: 'rm -rf /' } }) })],
      routes: { [answerRoute()]: accepted },
    });

    const result = await run('request_answer', { id: 'w1', requestId: 'req-1', choice: 'allow_once' }, ctx);

    const shown = JSON.stringify([result.data, result.summary, result.activity]);
    expect(shown).not.toMatch(/IGNORE-ALL|rm -rf/);
  });

  it('keeps the request id and the option index to what the route takes', () => {
    const tool = allTools().find((t) => t.name === 'request_answer')!;
    const schema = z.object(tool.input);
    const base = { id: 'w1', requestId: 'r', choice: 'option' as const };

    expect(schema.safeParse({ ...base, optionIndex: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...base, optionIndex: 99 }).success).toBe(true);
    for (const optionIndex of [-1, 100, 1.5]) expect(schema.safeParse({ ...base, optionIndex }).success, String(optionIndex)).toBe(false);
    expect(schema.safeParse({ ...base, requestId: '' }).success).toBe(false);
    expect(schema.safeParse({ ...base, requestId: 'x'.repeat(201) }).success).toBe(false);
    expect(tool).toMatchObject({ toolset: 'requests', risk: 'steers', phase: 2 });
  });
});

// ---------------------------------------------------------------------------
// snippet_use
// ---------------------------------------------------------------------------

describe('snippet_use', () => {
  const snippets = [
    { id: 2, label: '', text: 'Summarize', useCount: 1, lastUsedAt: 5, createdAt: 1 },
    { id: 3, label: 'review', text: 'Review the diff and list the risks.', useCount: 4, lastUsedAt: NOW, createdAt: 2 },
  ];
  const used = ok({ success: true, revision: 9, snippets });

  it('marks a saved prompt used and gives back its text, plain: it is the person’s own library', async () => {
    const { ctx, client } = deliverCtx({ routes: { 'POST /snippets/3/use': used } });

    const result = await run('snippet_use', { id: 3 }, ctx);

    expect(client.calls).toEqual([{ method: 'POST', path: '/snippets/3/use' }]);
    expect(result.data).toEqual({ id: 3, label: 'review', text: 'Review the diff and list the risks.', useCount: 4, lastUsedAt: NOW });
    expect(result.summary).toContain('Review the diff and list the risks.');
    expect(result.summary).not.toContain('<untrusted');
    expect(result.summary).toMatch(/prompt_send|queue/);
    expect(result.activity).toEqual([{ summary: 'Used saved prompt #3.', detail: { snippetId: 3, useCount: 4 } }]);
  });

  it('answers a saved prompt that is not there as not found', async () => {
    const { ctx } = deliverCtx({ routes: { 'POST /snippets/9/use': refusedBy(404, 'No such saved prompt') } });

    const err = await runRefused('snippet_use', { id: 9 }, ctx);

    expect(err.code).toBe('NOT_FOUND');
    expect(err.hint).toContain('snippet_list');
  });

  it('is upstream trouble when the route says it was used but does not list it', async () => {
    const { ctx } = deliverCtx({ routes: { 'POST /snippets/7/use': used } });

    expect((await runRefused('snippet_use', { id: 7 }, ctx)).code).toBe('UPSTREAM');
  });

  it('takes the number snippet_list shows, nothing else', async () => {
    const tool = allTools().find((t) => t.name === 'snippet_use')!;
    const schema = z.object(tool.input);

    expect(schema.safeParse({ id: 3 }).success).toBe(true);
    for (const id of [0, -1, 1.5, '3', null, 2 ** 60]) expect(schema.safeParse({ id }).success, String(id)).toBe(false);
    expect(tool).toMatchObject({ toolset: 'snippets', risk: 'write', phase: 2 });
    expect(tool.description).toMatch(/prompt_send|queue/);
  });
});
