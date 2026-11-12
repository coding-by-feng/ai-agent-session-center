// test/promptRouterStart.test.ts — Nov 12 2026: a person's prompt to a card whose agent hasn't started is held, not
// refused. A card still `connecting` is waited for; a card with no terminal that can relaunch (SSH config or a captured
// startupCommand) is started the way RECONNECT starts it. The prompt is typed once its agent is in front and AASC has
// heard a hook from its terminal (never into the folder-trust dialog), at most `agentStartWaitMs`. A central's prompt
// is never held. The submitter and the start are fakes: nothing reaches a terminal or a process.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false }));
vi.mock('../server/logger.js', () => ({ default: log }));

import { createPromptRouter, type PromptRouterSession } from '../server/promptRouter.js';
import type { PromptRequest, PromptResult } from '../server/promptSubmit.js';

let server: http.Server;
let port: number;
let sessions: Map<string, PromptRouterSession>;
let terminals: Set<string>;
let foreground: Map<string, string>;
let heard: Set<string>;
let submit: ReturnType<typeof vi.fn<(req: PromptRequest) => Promise<PromptResult>>>;
let startAgent: ReturnType<typeof vi.fn<(sessionId: string, req: Request) => Promise<boolean>>>;
let access: boolean;
let withStart: boolean;

/** What a successful RECONNECT does to the card: a new terminal, the card connecting, the CLI not yet up. */
function opensTerminal(sessionId: string, terminalId: string): void {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`no ${sessionId}`);
  sessions.set(sessionId, { ...s, terminalId, status: 'connecting' });
  terminals.add(terminalId);
  foreground.set(terminalId, 'zsh');
}

/** The CLI is up: in front of its terminal, its SessionStart heard, the card idle. */
function agentUp(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s?.terminalId) throw new Error(`no terminal for ${sessionId}`);
  foreground.set(s.terminalId, 'claude');
  heard.add(s.terminalId);
  sessions.set(sessionId, { ...s, status: 'idle' });
}

async function build(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPromptRouter({
    requireVisibleSession: (_req: Request, _res: Response, next: NextFunction) => next(),
    isLocal: (req) => req.headers['x-test-remote'] === undefined,
    remoteAccess: () => () => access,
    clientIdOf: (req) => (typeof req.headers['x-test-client'] === 'string' ? req.headers['x-test-client'] : ''),
    getSession: (id) => sessions.get(id) ?? null,
    terminalExists: (id) => terminals.has(id),
    foregroundProcess: (id) => foreground.get(id) ?? null,
    noteControlActivity: () => true,
    canControl: () => true,
    controller: () => null,
    resolveImage: () => null,
    submitter: { submit, hasRoom: () => true },
    terminalHeard: (id) => heard.has(id),
    ...(withStart ? { startAgent } : {}),
    agentStartWaitMs: 400,
    agentStartPollMs: 10,
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  sessions = new Map<string, PromptRouterSession>([
    // Back from a server restart: idle, no terminal, its launch line known.
    ['cold', { sessionId: 'cold', terminalId: null, status: 'idle', startupCommand: 'claude -n "Claude"' }],
    ['ssh', { sessionId: 'ssh', terminalId: null, status: 'idle', source: 'ssh' }],
    ['shell', { sessionId: 'shell', terminalId: null, status: 'idle' }],
    ['gone', { sessionId: 'gone', terminalId: null, status: 'ended', startupCommand: 'claude' }],
    ['starting', { sessionId: 'starting', terminalId: 'term-s', status: 'connecting', startupCommand: 'claude' }],
  ]);
  terminals = new Set(['term-s']);
  foreground = new Map([['term-s', 'zsh']]);
  heard = new Set();
  submit = vi.fn(async () => ({ outcome: 'submitted' as const, typed: true }));
  startAgent = vi.fn(async (sessionId: string) => {
    opensTerminal(sessionId, `term-${sessionId}-new`);
    return true;
  });
  access = true;
  withStart = true;
  log.warn.mockClear();
  await build();
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function call(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api${path}`,
      headers: { ...headers, ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const send = (session: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call(`/sessions/${session}/prompt`, { key: 'key-00000001', text: 'hi', ...body }, headers);
const stateOf = async (session: string, key = 'key-00000001') => (await call(`/sessions/${session}/prompt/${key}`)).json.data as Record<string, unknown>;
const until = (test: () => boolean) => vi.waitFor(() => { if (!test()) throw new Error('not yet'); }, { timeout: 2_000, interval: 5 });

describe('a prompt to a card whose agent is not running', () => {
  it('starts the card, waits for its agent, then types the prompt into the new terminal', async () => {
    const res = await send('cold');
    expect(res.status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    expect(startAgent.mock.calls[0][0]).toBe('cold');
    // Terminal open, CLI not up: nothing typed yet.
    await new Promise((r) => setTimeout(r, 40));
    expect(submit).not.toHaveBeenCalled();
    expect(await stateOf('cold')).toMatchObject({ state: 'pending' });

    agentUp('cold');
    await until(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0][0]).toMatchObject({ sessionId: 'cold', terminalId: 'term-cold-new', text: 'hi', mode: 'now' });
    await until(() => submit.mock.results.length === 1);
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'submitted' }));
  });

  it('starts an SSH card too: it relaunches from its config', async () => {
    expect((await send('ssh')).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    agentUp('ssh');
    await until(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0][0].terminalId).toBe('term-ssh-new');
  });

  it('never types while the agent is up but unheard: a folder-trust dialog fires no hook', async () => {
    expect((await send('cold')).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    const s = sessions.get('cold')!;
    foreground.set(s.terminalId!, 'claude');
    sessions.set('cold', { ...s, status: 'idle' });
    await new Promise((r) => setTimeout(r, 60));
    expect(submit).not.toHaveBeenCalled();
    heard.add(s.terminalId!);
    await until(() => submit.mock.calls.length === 1);
  });

  it('ends the key failed with nothing typed when the agent never comes up, so sending again is safe', async () => {
    expect((await send('cold')).status).toBe(202);
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'failed' }), { timeout: 2_000 });
    expect(submit).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('prompt', expect.stringContaining('didn’t start'.replace('’', "'")));

    // Nothing was typed, so sending it again is safe; the phone sends it again under a new key (usePromptSender).
    agentUp('cold');
    expect((await send('cold', { key: 'key-00000002' })).status).toBe(202);
    await until(() => submit.mock.calls.length === 1);
  });

  it('ends the key failed when the start itself fails', async () => {
    startAgent.mockResolvedValueOnce(false);
    expect((await send('cold')).status).toBe(202);
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'failed' }));
    expect(submit).not.toHaveBeenCalled();
  });

  it('ends the key failed, not an unhandled rejection, when the start throws', async () => {
    startAgent.mockRejectedValueOnce(new Error('pty spawn failed'));
    expect((await send('cold')).status).toBe(202);
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'failed' }));
  });

  it('stops when the card ends while the prompt waits', async () => {
    expect((await send('cold')).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    sessions.set('cold', { ...sessions.get('cold')!, status: 'ended' });
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'failed' }));
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends an interrupt as a plain prompt: a fresh agent has no turn to stop', async () => {
    expect((await send('cold', { mode: 'interrupt' })).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    agentUp('cold');
    await until(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0][0].mode).toBe('now');
  });

  it('does not type for a remote device that lost the session while it waited', async () => {
    expect((await send('cold', {}, { 'x-test-remote': '1', 'x-test-client': 'phone-1' })).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    access = false;
    agentUp('cold');
    await vi.waitFor(async () => expect(await stateOf('cold')).toMatchObject({ state: 'stopped' }));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('repeats and limits while a card starts', () => {
  // Review finding: the start gives the card a new terminal, which is in the key's digest. A repeat of a lost 202
  // was 409 key_reused, and the phone then sent the message again under a new key: typed twice.
  it('a repeat of the same key after the start replays the first answer and types once', async () => {
    expect((await send('cold')).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    expect(sessions.get('cold')!.terminalId).toBe('term-cold-new');

    const repeat = await send('cold');
    expect(repeat.status).toBe(202);
    expect(repeat.json).toEqual({ success: true, data: { accepted: true, key: 'key-00000001' } });
    agentUp('cold');
    await until(() => submit.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it('the same key with another prompt is still key_reused', async () => {
    expect((await send('cold')).status).toBe(202);
    await until(() => startAgent.mock.calls.length === 1);
    expect((await send('cold', { text: 'something else' })).json).toMatchObject({ code: 'key_reused' });
  });

  it('holds two prompts per card, as a terminal takes two; a third is 409 busy', async () => {
    expect((await send('starting', { key: 'key-00000001' })).status).toBe(202);
    expect((await send('starting', { key: 'key-00000002' })).status).toBe(202);
    const third = await send('starting', { key: 'key-00000003' });
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ code: 'busy' });
    agentUp('starting');
    await until(() => submit.mock.calls.length === 2);
    // Both sent: the card takes held prompts again.
    await until(() => submit.mock.results.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    sessions.set('starting', { ...sessions.get('starting')!, status: 'connecting' });
    expect((await send('starting', { key: 'key-00000004' })).status).toBe(202);
  });

  it('logs why a start failed', async () => {
    startAgent.mockRejectedValueOnce(new Error('pty spawn failed'));
    expect((await send('cold')).status).toBe(202);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('prompt', expect.stringContaining('pty spawn failed')));
  });
});

describe('a prompt to a card still connecting', () => {
  it('is held, without a second start, and typed once the agent is up', async () => {
    expect((await send('starting')).status).toBe(202);
    await new Promise((r) => setTimeout(r, 40));
    expect(startAgent).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    agentUp('starting');
    await until(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0][0]).toMatchObject({ terminalId: 'term-s', mode: 'now' });
  });
});

describe('what is still refused', () => {
  it('a card that cannot relaunch: no SSH config, no launch line', async () => {
    const res = await send('shell');
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('an ended card: RECONNECT is the person’s explicit choice there', async () => {
    const res = await send('gone');
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('a central’s prompt: never held, never starts a card (Rulings P4-35, P4-41, P4-50)', async () => {
    const central = { 'x-test-client': 'mcp:central-1' };
    expect((await send('starting', {}, central)).json).toMatchObject({ code: 'agent_not_ready' });
    expect((await send('cold', { key: 'key-00000002' }, central)).json).toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(startAgent).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('everything, as before, when the server wires no start', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    withStart = false;
    await build();
    expect((await send('starting')).json).toMatchObject({ code: 'agent_not_ready' });
    expect((await send('cold', { key: 'key-00000002' })).json).toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(startAgent).not.toHaveBeenCalled();
  });
});
