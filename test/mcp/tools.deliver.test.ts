// test/mcp/tools.deliver.test.ts — the prompts toolset's P2 tools (server/mcp/tools/promptSend.ts, commandRun.ts):
// prompt_send, prompt_status and command_run. They type into other sessions, so every call goes through the rails
// (`ctx.mayDrive`: scope, kind, hands-off, the 60-second rule, the lock), the fan-out limit and the shell-line and
// slash-command rules, then through the prompt route (POST /sessions/:id/prompt) as the shared submitter takes it.
// A mock client stands in for the route: nothing here reaches a terminal or a process.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { entryToken, type CommandEntry } from '../../src/lib/commandIndex.js';
import { MAX_PROMPT_IMAGES, MAX_PROMPT_TEXT } from '../../server/promptRouter.js';
import { allTools, type ToolContext } from '../../server/mcp/registry.js';
import { ToolError } from '../../server/mcp/types.js';
import {
  deliverCtx,
  promptBodies,
  promptRoutes,
  refusedBy,
  worker,
} from './deliverToolFixtures.js';
import { dataOf, makeCentral, makeRoom, NOW, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const KEY = /^mcp-central_-\d+$/;

/** Runs a tool's `run` without its argument check: for the rails a tool keeps of its own besides its schema. */
async function runRaw(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`No registered tool named ${name}`);
  return tool.run(args, ctx);
}

async function refusalOf(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolError> {
  try {
    await runRaw(name, args, ctx);
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error(`${name} answered; a ToolError was expected`);
}

interface SendResult {
  ref: string;
  sessionId: string | null;
  shortId: string | null;
  key: string | null;
  accepted: boolean;
  code: string | null;
  reason: string | null;
  error: string | null;
  hint: string | null;
}
interface SendData {
  mode: string;
  requested: number;
  sent: number;
  results: SendResult[];
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i + 1}`);

// ---------------------------------------------------------------------------
// prompt_send
// ---------------------------------------------------------------------------

describe('prompt_send', () => {
  it('types a prompt into one session through the prompt route, and says how to follow it', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });

    const result = await run('prompt_send', { to: 'w1', text: 'Run the tests' }, ctx);

    expect(client.calls).toEqual([
      { method: 'POST', path: '/sessions/w1/prompt', body: { text: 'Run the tests', mode: 'now', key: expect.stringMatching(KEY) } },
    ]);
    expect(result.data).toMatchObject({
      mode: 'now',
      requested: 1,
      sent: 1,
      results: [{ ref: 'w1', sessionId: 'w1', shortId: 'w1', key: expect.stringMatching(KEY), accepted: true, code: null, reason: null, error: null, hint: null }],
    });
    expect(result.summary).toContain('prompt_status');
    expect(result.activity).toEqual([
      { summary: 'Sent a prompt of 13 characters.', targetSessionId: 'w1', detail: { key: expect.stringMatching(KEY), mode: 'now', chars: 13, images: 0 } },
    ]);
  });

  it('takes a list of sessions as well as one, and sends each its own prompt with a key of its own', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1'), worker('w2')], routes: promptRoutes('w1', 'w2') });

    const data = await dataOf<SendData>('prompt_send', { to: ['w1', 'w2'], text: 'Status?' }, ctx);

    expect(client.calls.map((c) => c.path)).toEqual(['/sessions/w1/prompt', '/sessions/w2/prompt']);
    const keys = promptBodies({ client }).map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
    expect(data.results.map((r) => [r.sessionId, r.accepted])).toEqual([['w1', true], ['w2', true]]);
    expect(data.sent).toBe(2);
  });

  it('prompt_send refuses a shell line', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });

    for (const text of ['!ls', '  !ls', '\n\t!rm -rf /', '\u0007!ls']) {
      const err = await runRefused('prompt_send', { to: 'w1', text }, ctx);
      expect(err.code, JSON.stringify(text)).toBe('INVALID');
      expect(err.message).toMatch(/shell/i);
    }
    expect(client.calls).toEqual([]);
    // A ! anywhere but the start is plain text.
    await run('prompt_send', { to: 'w1', text: 'what does a!b mean?' }, ctx);
    expect(client.calls).toHaveLength(1);
  });

  it('prompt_send fans out to at most 8', async () => {
    const nine = ids(9);
    const { ctx, client } = deliverCtx({ sessions: nine.map((id) => worker(id)), routes: promptRoutes(...nine) });
    const tool = allTools().find((t) => t.name === 'prompt_send')!;

    // The schema tells a client the limit, and the tool keeps it when the schema is bypassed.
    expect(z.object(tool.input).safeParse({ to: nine, text: 'x' }).success).toBe(false);
    expect(z.object(tool.input).safeParse({ to: nine.slice(0, 8), text: 'x' }).success).toBe(true);
    const err = await refusalOf('prompt_send', { to: nine, text: 'x' }, ctx);
    expect(err.code).toBe('INVALID');
    expect(client.calls).toEqual([]);

    const data = await dataOf<SendData>('prompt_send', { to: nine.slice(0, 8), text: 'x' }, ctx);
    expect(data.sent).toBe(8);
    expect(client.calls).toHaveLength(8);
  });

  it('counts the sessions named, not only those it could find: nine references are too many whatever they resolve to', async () => {
    const eight = ids(8);
    const { ctx, client } = deliverCtx({ sessions: eight.map((id) => worker(id)), routes: promptRoutes(...eight) });

    const err = await refusalOf('prompt_send', { to: [...eight, 'nowhere-9'], text: 'x' }, ctx);

    expect(err.code).toBe('INVALID');
    expect(client.calls).toEqual([]);
  });

  it('refuses a session named twice, whether by the same words or by a prefix and the whole id', async () => {
    const whole = 'session-abcdef-1';
    const { ctx, client } = deliverCtx({ sessions: [worker(whole)], routes: promptRoutes(whole) });

    for (const to of [[whole, whole], [whole, 'session-abcdef']]) {
      const err = await runRefused('prompt_send', { to, text: 'x' }, ctx);
      expect(err.code, to.join()).toBe('INVALID');
    }
    expect(client.calls).toEqual([]);
  });

  it('goes on to the next session when a rail refuses one of a fan-out, and says which and why', async () => {
    const sessions = [worker('w1'), worker('w2', { handsOff: true }), worker('w3')];
    const { ctx, client } = deliverCtx({ sessions, routes: promptRoutes('w1', 'w2', 'w3') });

    const result = await run('prompt_send', { to: ['w1', 'w2', 'w3'], text: 'hello' }, ctx);

    expect(client.calls.map((c) => c.path)).toEqual(['/sessions/w1/prompt', '/sessions/w3/prompt']);
    const data = result.data as SendData;
    expect(data.sent).toBe(2);
    expect(data.results[1]).toMatchObject({ sessionId: 'w2', key: null, accepted: false, code: 'HANDS_OFF' });
    expect(data.results[1].error).toMatch(/hands-off/i);
    // The policy refusal is in the activity log already (as ctx.mayDrive throws it): the tool adds no note for it.
    expect(result.activity?.map((n) => n.targetSessionId)).toEqual(['w1', 'w3']);
    expect(result.summary).toMatch(/2 of 3/);
  });

  it('says nothing was sent, and still answers, when every session of a fan-out is refused', async () => {
    const sessions = [worker('w1', { handsOff: true }), worker('w2', { handsOff: true })];
    const { ctx, client } = deliverCtx({ sessions, routes: promptRoutes('w1', 'w2') });

    const result = await run('prompt_send', { to: ['w1', 'w2'], text: 'hello' }, ctx);

    expect(client.calls).toEqual([]);
    expect(result.data).toMatchObject({ requested: 2, sent: 0 });
    expect((result.data as SendData).results.map((r) => r.code)).toEqual(['HANDS_OFF', 'HANDS_OFF']);
    expect(result.summary).toMatch(/Not sent to any of the 2 sessions/);
    expect(result.activity).toEqual([]);
  });

  it('throws the refusal itself when the one session it was given is refused', async () => {
    const { ctx, client } = deliverCtx({
      sessions: [worker('w1', { handsOff: true }), worker('w2'), worker('w3')],
      routes: promptRoutes('w1', 'w2', 'w3'),
      controller: (id) => (id === 'w2' ? { clientId: 'desktop-1', lastActivityAt: NOW - 30_000 } : null),
    });

    expect((await runRefused('prompt_send', { to: 'w1', text: 'x' }, ctx)).code).toBe('HANDS_OFF');
    const human = await runRefused('prompt_send', { to: 'w2', text: 'x' }, ctx);
    expect(human.code).toBe('HUMAN_ACTIVE');
    expect(human.hint).toMatch(/\d+ s/);
    // A central that drove it last, or a person more than a minute ago, does not stop it.
    const quiet = deliverCtx({
      sessions: [worker('w3')],
      routes: promptRoutes('w3'),
      controller: () => ({ clientId: 'mcp:central-2', lastActivityAt: NOW - 1_000 }),
    });
    await run('prompt_send', { to: 'w3', text: 'x' }, quiet.ctx);
    expect(client.calls).toEqual([]);
    expect(quiet.client.calls).toHaveLength(1);
  });

  it('refuses a session that holds a task a central gave it (the lock), and a session outside its scope', async () => {
    const { ctx, client, base } = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [worker('w1'), worker('w2')],
      rooms: [makeRoom('r1', ['w1'])],
      routes: promptRoutes('w1', 'w2'),
    });
    base.create({ central: makeCentral('global', null, { centralId: 'central-9', terminalId: 'term-c9' }), session: worker('w1'), task: 'busy' });

    expect((await runRefused('prompt_send', { to: 'w1', text: 'x' }, ctx)).code).toBe('BUSY');
    expect((await runRefused('prompt_send', { to: 'w2', text: 'x' }, ctx)).code).toBe('NOT_IN_SCOPE');
    expect(client.calls).toEqual([]);
  });

  it('reports a session it cannot name in a fan-out as refused, and throws when it is the only one', async () => {
    const { ctx } = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [worker('w1'), worker('w2')],
      rooms: [makeRoom('r1', ['w1'])],
      routes: promptRoutes('w1', 'w2'),
    });

    const result = await run('prompt_send', { to: ['w1', 'nowhere-1', 'w2'], text: 'hello' }, ctx);

    const data = result.data as SendData;
    expect(data.results.map((r) => [r.sessionId, r.code])).toEqual([['w1', null], [null, 'NOT_FOUND'], [null, 'NOT_IN_SCOPE']]);
    // Nothing is said about a session out of scope: the words of its refusal never name it.
    expect(`${data.results[2].error} ${data.results[2].hint}`).not.toContain('w2');
    expect(data.results[2].sessionId).toBeNull();
    expect(result.activity?.filter((n) => n.outcome === 'refused')).toEqual([
      { summary: expect.stringMatching(/^Refused \(NOT_FOUND\)/), outcome: 'refused', detail: { code: 'NOT_FOUND' } },
      { summary: expect.stringMatching(/^Refused \(NOT_IN_SCOPE\)/), outcome: 'refused', detail: { code: 'NOT_IN_SCOPE' } },
    ]);
    expect((await runRefused('prompt_send', { to: 'nowhere-1', text: 'x' }, ctx)).code).toBe('NOT_FOUND');
  });

  it('tells a session the route refused apart from one a rail refused: not thrown, with the route’s own reason', async () => {
    const { ctx } = deliverCtx({
      sessions: [worker('w1')],
      routes: { 'POST /sessions/w1/prompt': refusedBy(409, 'The agent is waiting for an answer; answer it or interrupt', 'awaiting_answer') },
    });

    const result = await run('prompt_send', { to: 'w1', text: 'go on' }, ctx);

    const [r] = (result.data as SendData).results;
    // The route keeps a key only for a prompt it took: a refused one has none to ask prompt_status about.
    expect(r).toMatchObject({ sessionId: 'w1', key: null, accepted: false, code: 'UNAVAILABLE', reason: 'awaiting_answer' });
    expect(r.error).toBe('The agent is waiting for an answer; answer it or interrupt');
    expect(r.hint).toMatch(/request_answer/);
    expect(r.hint).toMatch(/interrupt/);
    expect(result.summary).toMatch(/not sent/i);
    expect(result.activity).toEqual([
      { summary: 'The prompt route refused the prompt (HTTP 409).', targetSessionId: 'w1', outcome: 'refused', detail: { code: 'awaiting_answer', status: 409 } },
    ]);
  });

  it('a card whose CLI was never heard: the hint says the person answers its question, not to retry (Ruling P4-41)', async () => {
    const { ctx } = deliverCtx({
      sessions: [worker('w1')],
      routes: { 'POST /sessions/w1/prompt': refusedBy(409, 'The session has not reported that it started.', 'not_started') },
    });

    const [r] = ((await run('prompt_send', { to: 'w1', text: 'go on' }, ctx)).data as SendData).results;

    expect(r).toMatchObject({ accepted: false, code: 'UNAVAILABLE', reason: 'not_started' });
    expect(r.hint).toMatch(/trusting its folder/);
    expect(r.hint).not.toMatch(/try again in a moment/);
  });

  it.each([
    [409, 'busy', 'BUSY'],
    [409, 'agent_not_ready', 'UNAVAILABLE'],
    [409, 'AGENT_NOT_RUNNING', 'UNAVAILABLE'],
    [409, 'key_reused', 'INVALID'],
    [400, 'needs_argument', 'INVALID'],
    [400, 'image_not_found', 'INVALID'],
    [404, undefined, 'NOT_FOUND'],
    [423, 'control_held', 'UNAVAILABLE'],
    [429, undefined, 'BUDGET'],
    [503, undefined, 'UNAVAILABLE'],
    [500, undefined, 'UPSTREAM'],
    [0, undefined, 'UPSTREAM'],
  ])('maps the route’s %i %s to %s', async (status, reason, code) => {
    const { ctx } = deliverCtx({
      sessions: [worker('w1')],
      routes: { 'POST /sessions/w1/prompt': refusedBy(status, 'the route’s words', reason) },
    });

    const result = await run('prompt_send', { to: 'w1', text: 'x' }, ctx);

    const [r] = (result.data as SendData).results;
    expect(r).toMatchObject({ accepted: false, code, reason: reason ?? null });
    expect(r.hint).toBeTruthy();
    // The route said no (4xx) or could not say (no answer, 5xx): the log tells a refusal from a failure.
    expect(result.activity?.[0]).toMatchObject({ targetSessionId: 'w1', outcome: status === 0 || status >= 500 ? 'failed' : 'refused' });
  });

  it('never repeats a central’s own words in a refusal: not the text, not the session reference', async () => {
    const { ctx } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });
    const secret = 'my-secret-api-key-123';

    const shell = await runRefused('prompt_send', { to: 'w1', text: `!echo ${secret}` }, ctx);
    const unknown = await runRefused('prompt_send', { to: `zz-${secret}`, text: 'x' }, ctx);
    const command = await runRefused('prompt_send', { to: 'w1', text: `/clear ${secret}` }, ctx);

    for (const err of [shell, unknown, command]) {
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(secret);
    }
  });

  it('sends the saved images by id, and the mode it was asked for', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });

    await run('prompt_send', { to: 'w1', text: 'look at this', imageIds: ['queue-img-1-abc123.png'], mode: 'interrupt' }, ctx);
    await run('prompt_send', { to: 'w1', text: 'no pictures' }, ctx);

    const [first, second] = promptBodies({ client });
    expect(first).toMatchObject({ text: 'look at this', images: ['queue-img-1-abc123.png'], mode: 'interrupt' });
    expect(second).not.toHaveProperty('images');
    expect(second).toMatchObject({ mode: 'now' });
  });

  it('keeps to the route’s limits: 4 images, 65 536 characters, a text that is not blank', () => {
    const tool = allTools().find((t) => t.name === 'prompt_send')!;
    const schema = z.object(tool.input);
    const ok4 = ['queue-img-1-a.png', 'queue-img-2-b.png', 'queue-img-3-c.png', 'queue-img-4-d.png'];

    expect(MAX_PROMPT_IMAGES).toBe(4);
    expect(MAX_PROMPT_TEXT).toBe(65_536);
    expect(schema.safeParse({ to: 'w1', text: 'x', imageIds: ok4 }).success).toBe(true);
    expect(schema.safeParse({ to: 'w1', text: 'x', imageIds: [...ok4, 'queue-img-5-e.png'] }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: 'x'.repeat(MAX_PROMPT_TEXT) }).success).toBe(true);
    expect(schema.safeParse({ to: 'w1', text: 'x'.repeat(MAX_PROMPT_TEXT + 1) }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: '   \n ' }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: '' }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: 'x', mode: 'later' }).success).toBe(false);
    expect(schema.safeParse({ to: [], text: 'x' }).success).toBe(false);
  });

  it('lets the central pick the dedup key: the same key for the same terminal is the same request key', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1'), worker('w2')], routes: promptRoutes('w1', 'w2') });

    await run('prompt_send', { to: 'w1', text: 'x', key: 'retry-1' }, ctx);
    await run('prompt_send', { to: 'w1', text: 'x', key: 'retry-1' }, ctx);
    await run('prompt_send', { to: ['w1', 'w2'], text: 'x', key: 'retry-1' }, ctx);

    const keys = promptBodies({ client }).map((b) => b.key as string);
    for (const key of keys) expect(key).toMatch(/^mcp-central_-retry-1-[0-9a-f]{8}$/);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    // The route takes 8 to 64 characters of letters, digits and . _ : - only.
    const tool = allTools().find((t) => t.name === 'prompt_send')!;
    const schema = z.object(tool.input);
    expect(schema.safeParse({ to: 'w1', text: 'x', key: 'k'.repeat(24) }).success).toBe(true);
    expect(schema.safeParse({ to: 'w1', text: 'x', key: 'k'.repeat(25) }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: 'x', key: 'has space' }).success).toBe(false);
    expect(schema.safeParse({ to: 'w1', text: 'x', key: 'a/b' }).success).toBe(false);
  });

  it('keeps the key a central chose out of the activity log: it says only that there was one', async () => {
    const { ctx } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });
    const secret = 'sk-live-0123456789abcdef';

    const result = await run('prompt_send', { to: 'w1', text: 'x', key: secret.slice(0, 24) }, ctx);

    expect(result.activity?.[0].detail).toEqual({ keyed: true, mode: 'now', chars: 1, images: 0 });
    expect(JSON.stringify(result.activity)).not.toContain(secret.slice(0, 20));
  });

  it('makes the same request key for a session that re-keyed, as the route does: by its terminal, not its id', async () => {
    const before = deliverCtx({ sessions: [worker('term-1700-aaa', { terminalId: 'term-x' })], routes: promptRoutes('term-1700-aaa') });
    const after = deliverCtx({ sessions: [worker('claude-uuid-1', { terminalId: 'term-x' })], routes: promptRoutes('claude-uuid-1') });
    const other = deliverCtx({ sessions: [worker('claude-uuid-1', { terminalId: 'term-y' })], routes: promptRoutes('claude-uuid-1') });

    await run('prompt_send', { to: 'term-1700-aaa', text: 'x', key: 'retry-1' }, before.ctx);
    await run('prompt_send', { to: 'claude-uuid-1', text: 'x', key: 'retry-1' }, after.ctx);
    await run('prompt_send', { to: 'claude-uuid-1', text: 'x', key: 'retry-1' }, other.ctx);

    const [a] = promptBodies(before);
    const [b] = promptBodies(after);
    const [c] = promptBodies(other);
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });

  it('numbers the keys it makes itself, so no two prompts share one', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });

    await run('prompt_send', { to: 'w1', text: 'one' }, ctx);
    await run('prompt_send', { to: 'w1', text: 'two' }, ctx);

    const [a, b] = promptBodies({ client }).map((body) => body.key as string);
    expect(a).toMatch(KEY);
    expect(b).toMatch(KEY);
    expect(a).not.toBe(b);
    // A task's prompt key (the ledger's) cannot be one of these.
    expect(a).not.toMatch(/task/);
  });

  it('refuses text that starts as a slash command: the commands a central may run go through command_run', async () => {
    const { ctx, client } = deliverCtx({ sessions: [worker('w1')], routes: promptRoutes('w1') });

    for (const text of ['/clear', '/exit', ' /CLEAR now', '/delete', '/compact', '/plugin:skill args', '\u0007/login', '/clear!', '/exit?', '/logout,', '/clear)', '/clear\u200B', '/', '/_clear', '/-clear', '/1', '/.x', '/\u0301clear', '/\u00E9xit', '/\uFF43lear', '/clear/', '/logout/a', '/clear/x', '\u00AD/clear', '\u200E/clear', '\u200B/clear', '\u2060\uFEFF /clear']) {
      const err = await runRefused('prompt_send', { to: 'w1', text }, ctx);
      expect(err.code, text).toBe('INVALID');
      expect(err.hint, text).toContain('command_run');
    }
    expect(client.calls).toEqual([]);
    // A path, or a slash after the first word, is a prompt.
    await run('prompt_send', { to: 'w1', text: '/Users/me/proj/a.ts is broken' }, ctx);
    await run('prompt_send', { to: 'w1', text: 'please run /compact when you can' }, ctx);
    await run('prompt_send', { to: 'w1', text: '\uFF0Fclear it' }, ctx);
    expect(client.calls).toHaveLength(3);
  });

  it('is a steers tool of the prompts toolset, in phase 2', () => {
    const tool = allTools().find((t) => t.name === 'prompt_send')!;

    expect(tool).toMatchObject({ toolset: 'prompts', risk: 'steers', phase: 2 });
    expect(tool.description).toMatch(/task_delegate/);
  });
});

// ---------------------------------------------------------------------------
// prompt_status
// ---------------------------------------------------------------------------

describe('prompt_status', () => {
  const KEY1 = 'mcp-central_-7';

  it('asks the prompt route how a prompt went, and says what that means', async () => {
    const { ctx, client } = deliverCtx({
      sessions: [worker('w1')],
      routes: { [`GET /sessions/w1/prompt/${KEY1}`]: ok({ success: true, data: { key: KEY1, state: 'submitted' } }) },
    });

    const result = await run('prompt_status', { id: 'w1', key: KEY1 }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: `/sessions/w1/prompt/${KEY1}` }]);
    expect(result.data).toEqual({ id: 'w1', shortId: 'w1', key: KEY1, state: 'submitted' });
    expect(result.summary).toMatch(/took it/i);
  });

  it.each([
    ['pending', /still/i],
    ['submitted', /took it/i],
    ['unconfirmed', /slash command|not confirmed/i],
    ['stopped', /stopped/i],
    ['gave-up', /gave up/i],
    ['failed', /terminal/i],
  ])('words the state %s', async (state, words) => {
    const { ctx } = deliverCtx({
      sessions: [worker('w1')],
      routes: { [`GET /sessions/w1/prompt/${KEY1}`]: ok({ success: true, data: { key: KEY1, state } }) },
    });

    const result = await run('prompt_status', { id: 'w1', key: KEY1 }, ctx);

    expect((result.data as { state: string }).state).toBe(state);
    expect(result.summary).toMatch(words);
  });

  // P4-32 M7 (Ruling 66): who stopped it is a fact a central acts on, so it is in data, not only in words.
  it.each([
    ['hands-off', /hands-off/i],
    ['person', /person/i],
  ])('carries stoppedBy %s in data for a stopped prompt', async (stoppedBy, words) => {
    const { ctx } = deliverCtx({
      sessions: [worker('w1')],
      routes: { [`GET /sessions/w1/prompt/${KEY1}`]: ok({ success: true, data: { key: KEY1, state: 'stopped', stoppedBy } }) },
    });

    const result = await run('prompt_status', { id: 'w1', key: KEY1 }, ctx);

    expect(result.data).toEqual({ id: 'w1', shortId: 'w1', key: KEY1, state: 'stopped', stoppedBy });
    expect(result.summary).toMatch(words);
  });

  it('leaves stoppedBy out when the route sends none, or one it does not know, or the prompt was not stopped', async () => {
    for (const [state, stoppedBy] of [['stopped', undefined], ['stopped', 'robot'], ['submitted', 'person']] as const) {
      const { ctx } = deliverCtx({
        sessions: [worker('w1')],
        routes: { [`GET /sessions/w1/prompt/${KEY1}`]: ok({ success: true, data: { key: KEY1, state, ...(stoppedBy === undefined ? {} : { stoppedBy }) } }) },
      });

      const result = await run('prompt_status', { id: 'w1', key: KEY1 }, ctx);

      expect(result.data, `${state} ${String(stoppedBy)}`).toEqual({ id: 'w1', shortId: 'w1', key: KEY1, state });
    }
  });

  it('is scope-checked, and a key it did not make is not found, without asking the route', async () => {
    const { ctx, client } = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [worker('w1'), worker('w2')],
      rooms: [makeRoom('r1', ['w1'])],
      routes: { [`GET /sessions/w1/prompt/${KEY1}`]: ok({ success: true, data: { key: KEY1, state: 'pending' } }) },
    });

    expect((await runRefused('prompt_status', { id: 'w2', key: KEY1 }, ctx)).code).toBe('NOT_IN_SCOPE');
    expect((await runRefused('prompt_status', { id: 'w1', key: 'mcp-someone8-1' }, ctx)).code).toBe('NOT_FOUND');
    expect(client.calls).toEqual([]);
  });

  it('answers a key the route does not know as not found, and keeps a key to the characters a route path can hold', async () => {
    const { ctx } = deliverCtx({ sessions: [worker('w1')] });
    const tool = allTools().find((t) => t.name === 'prompt_status')!;

    expect((await runRefused('prompt_status', { id: 'w1', key: KEY1 }, ctx)).code).toBe('NOT_FOUND');
    expect(z.object(tool.input).safeParse({ id: 'w1', key: 'mcp-central_-1/../x' }).success).toBe(false);
    expect(tool).toMatchObject({ toolset: 'prompts', risk: 'read', phase: 2 });
  });
});

// ---------------------------------------------------------------------------
// command_run
// ---------------------------------------------------------------------------

describe('command_run', () => {
  const entry = (over: Partial<CommandEntry> & Pick<CommandEntry, 'name'>): CommandEntry => ({
    description: 'x',
    cli: 'claude',
    kind: 'command',
    source: 'global',
    ...over,
  });
  const deploy = entry({ name: 'deploy', kind: 'skill', source: 'project' });
  const plugin = entry({ name: 'tdd', kind: 'skill', source: 'plugin', pluginName: 'everything-claude-code' });
  const review = entry({ name: 'review', cli: 'codex', kind: 'skill' });

  const claudeWorker = (): ReturnType<typeof worker> => worker('w1', { cliSource: 'claude', projectPath: '/a/proj' });
  const codexWorker = (): ReturnType<typeof worker> => worker('w1', { cliSource: 'codex', projectPath: '/a/proj' });

  function setup(entries: CommandEntry[], session = claudeWorker()) {
    return deliverCtx({ sessions: [session], routes: { 'GET /commands': ok({ entries }), ...promptRoutes('w1') } });
  }

  const sentText = (h: { client: ReturnType<typeof setup>['client'] }): string[] =>
    promptBodies(h).map((b) => b.text as string);

  it('runs a command or skill of the session’s catalog, typed as its CLI expects, with the arguments after it', async () => {
    const { ctx, client } = setup([deploy]);

    const result = await run('command_run', { id: 'w1', name: 'deploy', args: 'staging now' }, ctx);

    expect(client.calls[0]).toEqual({ method: 'GET', path: '/commands', query: { cli: 'claude', projectPath: '/a/proj' } });
    expect(client.calls[1]).toMatchObject({ method: 'POST', path: '/sessions/w1/prompt', body: { text: '/deploy staging now', mode: 'now' } });
    expect(result.data).toMatchObject({ id: 'w1', command: '/deploy', accepted: true, key: expect.stringMatching(KEY) });
    expect(result.activity).toEqual([
      { summary: 'Ran /deploy.', targetSessionId: 'w1', detail: { key: expect.stringMatching(KEY), mode: 'now', chars: 19, images: 0 } },
    ]);
    // No arguments: just the command.
    await run('command_run', { id: 'w1', name: 'deploy' }, ctx);
    expect(sentText({ client })).toEqual(['/deploy staging now', '/deploy']);
  });

  it('command_run uses $ for a Codex skill', async () => {
    const codexCommand = entry({ name: 'init', cli: 'codex', kind: 'command', source: 'builtin' });
    const { ctx, client } = setup([review, codexCommand], codexWorker());

    await run('command_run', { id: 'w1', name: 'review', args: 'the last diff' }, ctx);

    expect(client.calls[0]).toMatchObject({ query: { cli: 'codex' } });
    expect(sentText({ client })).toEqual(['$review the last diff']);
    // The server's own rule, held to the client's: the sigil an entry gets is what `entryToken` gives.
    expect(entryToken(review)).toBe('$review');
    // A Codex prompt (not a skill) is /name.
    const prompts = setup([entry({ name: 'ship', cli: 'codex', kind: 'command', source: 'global' })], codexWorker());
    await run('command_run', { id: 'w1', name: 'ship' }, prompts.ctx);
    expect(sentText(prompts)).toEqual(['/ship']);
  });

  it('writes a plugin’s entry with its plugin, and takes the name any way the catalog shows it', async () => {
    const { ctx, client } = setup([plugin, deploy]);

    for (const name of ['everything-claude-code:tdd', 'tdd', '/tdd', '/everything-claude-code:tdd']) {
      await run('command_run', { id: 'w1', name }, ctx);
    }
    await run('command_run', { id: 'w1', name: '/deploy' }, ctx);
    await run('command_run', { id: 'w1', name: 'deploy' }, ctx);

    expect(sentText({ client })).toEqual([
      ...Array(4).fill('/everything-claude-code:tdd'),
      '/deploy',
      '/deploy',
    ]);
    expect(entryToken(plugin)).toBe('/everything-claude-code:tdd');
  });

  it('takes the sigil to tell a Codex prompt from a skill of the same name, and asks for it when the name is not enough', async () => {
    const prompt = entry({ name: 'foo', cli: 'codex', kind: 'command', source: 'global' });
    const skill = entry({ name: 'foo', cli: 'codex', kind: 'skill', source: 'global' });
    const { ctx, client } = setup([prompt, skill], codexWorker());

    const err = await runRefused('command_run', { id: 'w1', name: 'foo' }, ctx);
    await run('command_run', { id: 'w1', name: '$foo' }, ctx);
    await run('command_run', { id: 'w1', name: '/foo' }, ctx);

    expect(err.code).toBe('INVALID');
    expect(err.hint).toMatch(/\$|sigil/);
    expect(sentText({ client })).toEqual(['$foo', '/foo']);
  });

  it('command_run refuses clear and unknown names', async () => {
    const { ctx, client } = setup([deploy]);
    // With the CLIs' own aliases (A-M2): /reset and /new clear, /quit exits.
    const never = ['clear', 'reset', 'new', 'exit', 'quit', 'logout', 'login', 'permissions', 'hooks', 'mcp', 'config'];

    for (const name of never.flatMap((n) => [n, `/${n}`, n.toUpperCase(), `$${n}`])) {
      const err = await runRefused('command_run', { id: 'w1', name }, ctx);
      expect(err.code, name).toBe('INVALID');
      expect(err.message, name).toMatch(/never|clear|end|reconfigure/i);
    }
    // Refused before AASC reads a catalog or types a thing.
    expect(client.calls).toEqual([]);

    const unknown = await runRefused('command_run', { id: 'w1', name: 'nothing-like-it' }, ctx);
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.hint).toContain('command_list');
    expect(promptBodies({ client })).toEqual([]);
  });

  it('never types an entry whose name is not one clean word, though the catalog lists it', async () => {
    const odd = [
      entry({ name: 'deploy prod', kind: 'skill', source: 'project' }),
      entry({ name: 'ship;now', kind: 'command', source: 'global' }),
      entry({ name: 'tdd', kind: 'skill', source: 'plugin', pluginName: 'my plugin' }),
    ];
    const { ctx, client } = setup(odd);

    for (const name of ['deploy', 'ship', 'tdd', 'prod', 'now']) {
      expect((await runRefused('command_run', { id: 'w1', name }, ctx)).code, name).toBe('NOT_FOUND');
    }
    expect(promptBodies({ client })).toEqual([]);
  });

  it('refuses a name of the never-list even when a project’s own command has it', async () => {
    const mine = entry({ name: 'clear', kind: 'command', source: 'project' });
    const { ctx, client } = setup([mine, deploy]);

    expect((await runRefused('command_run', { id: 'w1', name: 'clear' }, ctx)).code).toBe('INVALID');
    expect(promptBodies({ client })).toEqual([]);
  });

  it('runs the safe built-ins even when the catalog does not list them, and only those (K4: compact, model, effort)', async () => {
    const { ctx, client } = setup([]);

    await run('command_run', { id: 'w1', name: 'compact' }, ctx);
    await run('command_run', { id: 'w1', name: 'model', args: 'sonnet' }, ctx);
    await run('command_run', { id: 'w1', name: '/effort', args: 'high' }, ctx);

    expect(sentText({ client })).toEqual(['/compact', '/model sonnet', '/effort high']);
  });

  it('command_run refuses bare model/effort and status/context/cost', async () => {
    const listed = ['status', 'context', 'cost', 'model', 'effort'].map((name) =>
      entry({ name, cli: 'claude', kind: 'command', source: 'builtin' }));
    for (const entries of [[], listed]) {
      const { ctx, client } = setup(entries);
      for (const name of ['model', '/model', 'effort', '/effort']) {
        const bare = await runRefused('command_run', { id: 'w1', name }, ctx);
        expect(bare.code, name).toBe('INVALID');
        expect(bare.hint, name).toMatch(/args/);
        expect((await runRefused('command_run', { id: 'w1', name, args: '  ' }, ctx)).code, name).toBe('INVALID');
      }
      for (const name of ['status', 'context', 'cost', '/status']) {
        const err = await runRefused('command_run', { id: 'w1', name }, ctx);
        expect(err.code === 'INVALID' || err.code === 'NOT_FOUND', name).toBe(true);
        expect(`${err.message} ${err.hint ?? ''}`, name).not.toMatch(/\b(status|context|cost)\b/);
      }
      expect(promptBodies({ client })).toEqual([]);
    }
  });

  it('runs a skill Codex preinstalls though the catalog files it as built-in (A-M7)', async () => {
    const imagegen = entry({ name: 'imagegen', cli: 'codex', kind: 'skill', source: 'builtin' });
    const { ctx, client } = setup([imagegen], codexWorker());

    await run('command_run', { id: 'w1', name: 'imagegen', args: 'a lighthouse' }, ctx);

    expect(sentText({ client })).toEqual(['$imagegen a lighthouse']);
  });

  it('refuses a built-in the catalog lists but a central does not run: rewind, resume, a Codex /delete', async () => {
    const listed = ['rewind', 'resume', 'delete', 'archive', 'fork', 'teleport'].map((name) =>
      entry({ name, cli: 'claude', kind: 'command', source: 'builtin' }));
    const { ctx, client } = setup(listed);

    for (const e of listed) {
      const err = await runRefused('command_run', { id: 'w1', name: e.name }, ctx);
      expect(err.code, e.name).toBe('INVALID');
      expect(err.message, e.name).toMatch(/built-in/i);
    }
    expect(promptBodies({ client })).toEqual([]);
  });

  it('command_run runs /review on a Codex card whose catalog lists it', async () => {
    const codexReview = entry({ name: 'review', cli: 'codex', kind: 'command', source: 'builtin' });
    const { ctx, client } = setup([codexReview], codexWorker());

    const result = await run('command_run', { id: 'w1', name: 'review' }, ctx);
    await run('command_run', { id: 'w1', name: '/review' }, ctx);

    expect(sentText({ client })).toEqual(['/review', '/review']);
    expect(result.data).toMatchObject({ command: '/review', accepted: true });
  });

  it('command_run runs /code-review on a Claude card', async () => {
    const codeReview = entry({ name: 'code-review', cli: 'claude', kind: 'command', source: 'builtin' });
    const { ctx, client } = setup([codeReview]);

    await run('command_run', { id: 'w1', name: 'code-review', args: 'high' }, ctx);

    expect(sentText({ client })).toEqual(['/code-review high']);
  });

  it('/review on a card whose catalog lacks it is refused', async () => {
    const { ctx, client } = setup([deploy], codexWorker());

    for (const name of ['review', '/review', 'code-review']) {
      expect((await runRefused('command_run', { id: 'w1', name }, ctx)).code, name).toBe('NOT_FOUND');
    }
    expect(promptBodies({ client })).toEqual([]);
  });

  it('says in its description that a bare /review opens Codex’s preset menu, answered with key_send', () => {
    const { description } = allTools().find((t) => t.name === 'command_run')!;
    expect(description).toMatch(/\/review/);
    expect(description).toMatch(/key_send/);
  });

  it('lists a built-in that is safe, whatever the catalog says about its source', async () => {
    const compact = entry({ name: 'compact', kind: 'command', source: 'builtin' });
    const { ctx, client } = setup([compact]);

    await run('command_run', { id: 'w1', name: 'compact' }, ctx);

    expect(sentText({ client })).toEqual(['/compact']);
  });

  it('runs nothing in a session whose CLI AASC does not know, or that no rail lets a central steer', async () => {
    const gemini = setup([deploy], worker('w1', { cliSource: 'gemini' }));
    const handsOff = setup([deploy], worker('w1', { cliSource: 'claude', handsOff: true }));
    const human = deliverCtx({
      sessions: [claudeWorker()],
      routes: { 'GET /commands': ok({ entries: [deploy] }), ...promptRoutes('w1') },
      controller: () => ({ clientId: 'desktop-1', lastActivityAt: NOW - 5_000 }),
    });

    expect((await runRefused('command_run', { id: 'w1', name: 'deploy' }, gemini.ctx)).code).toBe('INVALID');
    expect((await runRefused('command_run', { id: 'w1', name: 'deploy' }, handsOff.ctx)).code).toBe('HANDS_OFF');
    expect((await runRefused('command_run', { id: 'w1', name: 'deploy' }, human.ctx)).code).toBe('HUMAN_ACTIVE');
    for (const h of [gemini, handsOff, human]) expect(promptBodies(h)).toEqual([]);
    expect(gemini.client.calls).toEqual([]);
  });

  it('is scope-checked before it reads a catalog', async () => {
    const { ctx, client } = deliverCtx({
      central: makeCentral('room', 'r1'),
      sessions: [claudeWorker()],
      rooms: [makeRoom('r1', [])],
      routes: { 'GET /commands': ok({ entries: [deploy] }), ...promptRoutes('w1') },
    });

    expect((await runRefused('command_run', { id: 'w1', name: 'deploy' }, ctx)).code).toBe('NOT_IN_SCOPE');
    expect(client.calls).toEqual([]);
  });

  it('says when the route refuses a command that needs its choice (the picker commands), and when the catalog cannot be read', async () => {
    // A project's own command with a picker's name: command_run types it, the route refuses it bare.
    const theme = entry({ name: 'theme', kind: 'command', source: 'project' });
    const needs = deliverCtx({
      sessions: [claudeWorker()],
      routes: {
        'GET /commands': ok({ entries: [theme] }),
        'POST /sessions/w1/prompt': refusedBy(400, 'This command opens a picker; send it with its choice, like /model sonnet', 'needs_argument'),
      },
    });
    const noCatalog = deliverCtx({ sessions: [claudeWorker()], routes: { 'GET /commands': { ok: false, status: 503, data: null, error: 'down' } } });

    const result = await run('command_run', { id: 'w1', name: 'theme' }, needs.ctx);
    const err = await runRefused('command_run', { id: 'w1', name: 'compact' }, noCatalog.ctx);

    expect(result.data).toMatchObject({ accepted: false, code: 'INVALID', reason: 'needs_argument' });
    // The route will not type a picker command bare; one that takes no choice is the person's to run.
    expect((result.data as { hint: string }).hint).toMatch(/args sonnet.*ask the person/);
    expect(err.code).toBe('UNAVAILABLE');
    expect(promptBodies(noCatalog)).toEqual([]);
  });

  it('keeps the name to one word, and refuses arguments longer than a prompt', () => {
    const tool = allTools().find((t) => t.name === 'command_run')!;
    const schema = z.object(tool.input);

    expect(schema.safeParse({ id: 'w1', name: 'deploy' }).success).toBe(true);
    for (const name of ['', 'two words', 'a\nb', 'x/y', '$', '/', ' ', 'a;b']) {
      expect(schema.safeParse({ id: 'w1', name }).success, JSON.stringify(name)).toBe(false);
    }
    expect(schema.safeParse({ id: 'w1', name: 'x', args: 'y'.repeat(60_000) }).success).toBe(true);
    expect(schema.safeParse({ id: 'w1', name: 'x', args: 'y'.repeat(65_000) }).success).toBe(false);
    expect(tool).toMatchObject({ toolset: 'prompts', risk: 'steers', phase: 2 });
  });

  it('goes through the same send path as prompt_send, one key for it, nothing about the arguments in its log', async () => {
    const { ctx, client } = setup([deploy]);
    const secret = 'token-in-the-arguments-9';

    const result = await run('command_run', { id: 'w1', name: 'deploy', args: secret }, ctx);

    expect(promptBodies({ client })[0].key).toMatch(KEY);
    expect(JSON.stringify(result.activity)).not.toContain(secret);
    expect(result.activity?.[0].summary).not.toContain(secret);
  });

  it('refuses a ledger lock the same way prompt_send does', async () => {
    const h = setup([deploy]);
    const other = makeCentral('global', null, { centralId: 'central-9', terminalId: 'term-c9' });
    h.base.create({ central: other, session: worker('w1'), task: 'busy' });

    expect((await runRefused('command_run', { id: 'w1', name: 'deploy' }, h.ctx)).code).toBe('BUSY');
    expect(promptBodies(h)).toEqual([]);
  });
});
