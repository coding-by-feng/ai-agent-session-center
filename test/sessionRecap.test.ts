/**
 * The Summary button's server side (Nov 18 2026): one run per session, two at once, the result on the
 * session. The model is injected: no `claude` process is ever started here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRecapService, type RecapDeps } from '../server/sessionRecap.js';
import type { Session, SessionRecap } from '../src/types/session.js';

const T = 1_800_000_000_000;
const make = (id: string, over: Partial<Session> = {}) => ({
  sessionId: id, title: id, projectName: 'p', status: 'idle',
  promptHistory: [{ text: 'build it', timestamp: T }], responseLog: [{ text: 'Built.', timestamp: T + 1 }], ...over,
}) as unknown as Session;

let sessions: Map<string, Session>;
let saved: Array<[string, SessionRecap]>;
let release: Array<(text: string) => void>;
let fail: Array<(err: Error) => void>;
let prompts: string[];
let deps: RecapDeps;

beforeEach(() => {
  sessions = new Map([['a', make('a')], ['b', make('b')], ['c', make('c')], ['empty', make('empty', { promptHistory: [] })]]);
  saved = [];
  release = [];
  fail = [];
  prompts = [];
  deps = {
    getSession: (id) => sessions.get(id),
    setRecap: (id, recap) => {
      saved.push([id, recap]);
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, recap });
    },
    runModel: (prompt) => new Promise<string>((ok, no) => { prompts.push(prompt); release.push(ok); fail.push(no); }),
    now: () => T + 1000,
  };
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('recap service', () => {
  it('answers at once, marks the session running, then stores the summary', async () => {
    const service = createRecapService(deps);
    expect(service.request('a')).toEqual({ ok: true, state: 'running' });
    expect(saved[0]).toEqual(['a', { state: 'running', at: T + 1000, promptAt: T }]);
    expect(prompts[0]).toContain('build it');
    release[0]('- Built the thing\n- Nothing left');
    await settle();
    expect(saved[1]).toEqual(['a', { state: 'done', text: '• Built the thing\n• Nothing left', at: T + 1000, promptAt: T }]);
  });

  it('refuses a session it does not know, and one with nothing typed', () => {
    const service = createRecapService(deps);
    expect(service.request('nope')).toMatchObject({ ok: false, status: 404 });
    expect(service.request('empty')).toMatchObject({ ok: false, status: 400 });
    expect(prompts).toEqual([]);
  });

  it('runs one at a time per session and two at once in all', async () => {
    const service = createRecapService(deps);
    service.request('a');
    expect(service.request('a')).toEqual({ ok: true, state: 'running' });
    expect(prompts).toHaveLength(1);
    service.request('b');
    expect(service.request('c')).toMatchObject({ ok: false, status: 429 });
    release[0]('• done');
    await settle();
    expect(service.request('c')).toEqual({ ok: true, state: 'running' });
  });

  it('keeps the last summary on screen while a new one runs, and when the new one fails', async () => {
    const service = createRecapService(deps);
    service.request('a');
    release[0]('• first');
    await settle();
    sessions.set('a', { ...sessions.get('a')!, promptHistory: [{ text: 'build it', timestamp: T }, { text: 'deploy', timestamp: T + 50 }] });
    service.request('a');
    expect(saved[2][1]).toEqual({ state: 'running', text: '• first', at: T + 1000, promptAt: T });
    fail[1](Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await settle();
    expect(saved[3][1]).toMatchObject({ state: 'error', text: '• first', promptAt: T });
    expect(saved[3][1].error).toBe('the Claude CLI isn’t installed on this Mac');
  });

  it('says so when the model answers nothing, and never shows a raw error', async () => {
    const service = createRecapService(deps);
    service.request('a');
    release[0]('   ');
    await settle();
    expect(saved[1][1]).toMatchObject({ state: 'error', error: 'the summarizer gave no answer' });
    service.request('b');
    fail[1](new Error('ECONNRESET at /Users/me/secret/path.js:12'));
    await settle();
    expect(saved[3][1].error).toBe('the summarizer failed');
  });
});
