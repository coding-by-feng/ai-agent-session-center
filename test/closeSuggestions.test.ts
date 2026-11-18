// test/closeSuggestions.test.ts — which sessions the "Sessions to close" list suggests
// (server/closeSuggestions.ts). Read-only: nothing here closes or kills anything.
import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRefusal,
  createCloseSuggestionsRouter,
  listCloseSuggestions,
  type CloseContext,
} from '../server/closeSuggestions.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const MIN = 60_000;
const NOW = 10_000 * MIN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function quiet(over: Record<string, any> = {}): any {
  return {
    sessionId: 's1',
    status: 'waiting',
    terminalId: 'term-1',
    startedAt: NOW - 600 * MIN,
    lastActivityAt: NOW - 90 * MIN,
    promptHistory: [{ text: 'hello', timestamp: NOW - 90 * MIN }],
    ...over,
  };
}

function ctx(over: Partial<CloseContext> = {}): CloseContext {
  return {
    now: NOW,
    quietMinutes: 60,
    hasArmedQueue: () => false,
    ...over,
  };
}

describe('closeRefusal', () => {
  it('lists a session that has been quiet long enough', () => {
    expect(closeRefusal(quiet(), ctx())).toBeNull();
    expect(closeRefusal(quiet({ status: 'idle' }), ctx())).toBeNull();
  });

  it('lists what idle sleep cannot take: a remote host, a launch that cannot resume, a fork', () => {
    expect(closeRefusal(quiet({ sshConfig: { host: 'box.example' }, startupCommand: 'bash' }), ctx())).toBeNull();
    expect(closeRefusal(quiet({ isFork: true }), ctx())).toBeNull();
  });

  it.each([
    ['ended', quiet({ status: 'ended' }), {}],
    ['ended', quiet({ asleepAt: 1 }), {}],
    ['busy', quiet({ status: 'working' }), {}],
    ['busy', quiet({ status: 'prompting' }), {}],
    ['busy', quiet({ status: 'approval' }), {}],
    ['busy', quiet({ status: 'input' }), {}],
    // Without a dashboard terminal nobody can see typing, so quiet cannot be told from in use.
    ['no-terminal', quiet({ terminalId: null }), {}],
    ['no-terminal', quiet({ isExternal: true }), {}],
    ['pinned', quiet({ pinned: true }), {}],
    ['central', quiet({ central: { centralId: 'c1' } }), {}],
    ['hands-off', quiet({ handsOff: true }), {}],
    ['floating', quiet({ isFloating: true }), {}],
    ['team-member', quiet({ teamRole: 'member' }), {}],
    ['team-member', quiet({ isSubagent: true }), {}],
    ['background-shells', quiet({ backgroundTaskCount: 1 }), {}],
    ['asking', quiet({ pendingRequest: { kind: 'question' } }), {}],
    // "Recent" is the person's last prompt (Nov 18 2026), or the start of a session never prompted.
    ['recent', quiet({ promptHistory: [{ text: 'hi', timestamp: NOW - 59 * MIN }] }), {}],
    ['recent', quiet({ startedAt: NOW - 10 * MIN, lastActivityAt: 0, promptHistory: [] }), {}],
    ['queue-armed', quiet(), { hasArmedQueue: () => true }],
  ] as const)('never lists a session that is %s', (reason, session, over) => {
    expect(closeRefusal(session, ctx(over))).toBe(reason);
  });

  it('never lists a session running outside the dashboard, however long its hooks have been silent', () => {
    const scanned = quiet({ sessionId: 'external-4242', terminalId: null, isExternal: true, lastActivityAt: 0, startedAt: 0 });
    expect(listCloseSuggestions([scanned], ctx())).toEqual([]);
  });
});

describe('listCloseSuggestions', () => {
  it('says why each session is listed and how long it has been quiet', () => {
    const sessions = [
      quiet({ sessionId: 'idle-one' }),
      quiet({ sessionId: 'never-used', promptHistory: [], lastActivityAt: NOW - 300 * MIN, startedAt: NOW - 300 * MIN }),
      quiet({ sessionId: 'busy', status: 'working' }),
    ];
    expect(listCloseSuggestions(sessions, ctx())).toEqual([
      { sessionId: 'idle-one', reason: 'idle', quietMs: 90 * MIN },
      { sessionId: 'never-used', reason: 'unused', quietMs: 300 * MIN },
    ]);
  });

  it('measures quiet from the last prompt, not from hooks or terminal output (Nov 18 2026)', () => {
    // A TUI repaint, a status line or a Stop hook a minute ago is not the person using it.
    const prompted2DaysAgo = quiet({
      startedAt: NOW - 4000 * MIN,
      lastActivityAt: NOW - 1 * MIN,
      promptHistory: [{ text: 'old', timestamp: NOW - 3000 * MIN }, { text: 'last', timestamp: NOW - 2880 * MIN }],
    });
    const [row] = listCloseSuggestions([prompted2DaysAgo], ctx({ quietMinutes: 1440 }));
    expect(row).toEqual({ sessionId: 's1', reason: 'idle', quietMs: 2880 * MIN });
  });

  it('a session never prompted is quiet since its start, whatever its hooks did', () => {
    const [row] = listCloseSuggestions([quiet({ promptHistory: [], startedAt: NOW - 120 * MIN, lastActivityAt: NOW - 1 * MIN })], ctx());
    expect(row).toEqual({ sessionId: 's1', reason: 'unused', quietMs: 120 * MIN });
  });

  it('reads the newest prompt even if the history is out of order', () => {
    const s = quiet({ promptHistory: [{ text: 'b', timestamp: NOW - 30 * MIN }, { text: 'a', timestamp: NOW - 200 * MIN }] });
    expect(closeRefusal(s, ctx())).toBe('recent');
  });

  it('a wider quiet time lists fewer sessions', () => {
    expect(listCloseSuggestions([quiet()], ctx({ quietMinutes: 240 }))).toEqual([]);
  });
});

describe('GET /session-close-suggestions', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  async function serve(isLocal: boolean, sessions = [quiet()]): Promise<string> {
    const app = express();
    app.use('/api', createCloseSuggestionsRouter({
      sessions: () => sessions,
      hasArmedQueue: () => false,
      now: () => NOW,
      isLocal: () => isLocal,
    }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/session-close-suggestions`;
  }

  it('answers the suggestions for the default quiet time', async () => {
    const res = await fetch(await serve(true));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      at: NOW,
      quietMinutes: 60,
      suggestions: [{ sessionId: 's1', reason: 'idle', quietMs: 90 * MIN }],
    });
  });

  it('takes a quiet time from the list of choices', async () => {
    const res = await fetch(`${await serve(true)}?quietMinutes=240`);
    expect(await res.json()).toMatchObject({ ok: true, quietMinutes: 240, suggestions: [] });
  });

  it.each(['7', '0', '-60', 'abc', '60.5'])('refuses quietMinutes=%s', async (value) => {
    const res = await fetch(`${await serve(true)}?quietMinutes=${value}`);
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('is 404 to a device that is not this Mac', async () => {
    const res = await fetch(await serve(false));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'Not found' });
  });
});
