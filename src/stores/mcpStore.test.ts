import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { parseCentralRows, useMcpStore } from './mcpStore';
import type { CentralSummary } from '@/types';

const row = (over: Partial<CentralSummary> = {}): CentralSummary => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  sessionId: null,
  toolsets: ['sessions', 'system'],
  createdAt: 1_700_000_000_000,
  workerCount: 0,
  ...over,
});

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const INITIAL = { centrals: new Map<string, CentralSummary>(), available: null, passwordEnabled: null, revision: 0 };

describe('parseCentralRows', () => {
  it('keeps a well-formed row', () => {
    expect(parseCentralRows([row()])).toEqual([row()]);
  });

  it('is null for something that is not a list', () => {
    expect(parseCentralRows(undefined)).toBeNull();
    expect(parseCentralRows(null)).toBeNull();
    expect(parseCentralRows({ centrals: [] })).toBeNull();
    expect(parseCentralRows('c1')).toBeNull();
  });

  it('drops a row that is not one, and keeps the rest', () => {
    const rows = parseCentralRows([
      row({ centralId: 'a' }),
      null,
      'x',
      { centralId: 'no-kind', scopeRef: null, cli: 'claude', sessionId: null, toolsets: [], createdAt: 1 },
      { ...row({ centralId: 'bad-kind' }), kind: 'galaxy' },
      { ...row({ centralId: 'bad-cli' }), cli: 'aider' },
      { ...row({ centralId: 'bad-scope' }), scopeRef: 7 },
      { ...row({ centralId: 'bad-session' }), sessionId: 7 },
      { ...row({ centralId: 'bad-tools' }), toolsets: 'all' },
      { ...row({ centralId: 'bad-tool-name' }), toolsets: ['ok', 3] },
      { ...row({ centralId: 'bad-time' }), createdAt: 'yesterday' },
      { ...row({ centralId: '' }) },
      row({ centralId: 'b', kind: 'room', scopeRef: 'room-1' }),
    ]);

    expect(rows?.map((r) => r.centralId)).toEqual(['a', 'b']);
  });

  it('keeps only the public fields: a token a bad server sent along is never held', () => {
    const rows = parseCentralRows([{ ...row(), token: 'aasc_mcp_SECRET', terminalId: 'term-1' }]);

    expect(rows).toEqual([row()]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows?.[0]).not.toHaveProperty('token');
    expect(rows?.[0]).not.toHaveProperty('terminalId');
  });

  it('copies the toolsets: the row shares nothing with what it was read from', () => {
    const source = row({ toolsets: ['sessions'] });
    const [parsed] = parseCentralRows([source]) ?? [];

    parsed.toolsets.push('system');

    expect(source.toolsets).toEqual(['sessions']);
  });

  it('reads the count of live own workers, and 0 when a server older than P4 sends none or a bad one', () => {
    const older: Partial<CentralSummary> = row({ centralId: 'old' });
    delete older.workerCount;
    const rows = parseCentralRows([
      row({ centralId: 'three', workerCount: 3 }),
      older,
      { ...row({ centralId: 'negative' }), workerCount: -2 },
      { ...row({ centralId: 'fraction' }), workerCount: 1.5 },
      { ...row({ centralId: 'text' }), workerCount: '4' },
    ]);

    expect(rows?.map((r) => [r.centralId, r.workerCount])).toEqual([
      ['three', 3],
      ['old', 0],
      ['negative', 0],
      ['fraction', 0],
      ['text', 0],
    ]);
  });
});

describe('mcpStore', () => {
  beforeEach(() => {
    useMcpStore.setState(INITIAL);
  });

  describe('applyCentrals', () => {
    it('holds the list by central id', () => {
      useMcpStore.getState().applyCentrals([row({ centralId: 'a' }), row({ centralId: 'b', kind: 'room', scopeRef: 'room-1' })]);

      const { centrals } = useMcpStore.getState();
      expect([...centrals.keys()]).toEqual(['a', 'b']);
      expect(centrals.get('b')?.scopeRef).toBe('room-1');
    });

    it('replaces the list: a central that is gone from it is gone from the store', () => {
      useMcpStore.getState().applyCentrals([row({ centralId: 'a' }), row({ centralId: 'b', kind: 'room', scopeRef: 'r' })]);
      useMcpStore.getState().applyCentrals([row({ centralId: 'b', kind: 'room', scopeRef: 'r' })]);

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['b']);
      useMcpStore.getState().applyCentrals([]);
      expect(useMcpStore.getState().centrals.size).toBe(0);
    });

    it('never changes the map it replaces (a new Map each time, so subscribers see a change)', () => {
      useMcpStore.getState().applyCentrals([row({ centralId: 'a' })]);
      const before = useMcpStore.getState().centrals;

      useMcpStore.getState().applyCentrals([row({ centralId: 'a' }), row({ centralId: 'b', kind: 'room', scopeRef: 'r' })]);

      expect(useMcpStore.getState().centrals).not.toBe(before);
      expect([...before.keys()]).toEqual(['a']);
    });

    it('ignores a payload that is not a list, and keeps what it held', () => {
      useMcpStore.getState().applyCentrals([row({ centralId: 'a' })]);
      const revision = useMcpStore.getState().revision;

      useMcpStore.getState().applyCentrals({ centrals: [] });
      useMcpStore.getState().applyCentrals(undefined);

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
      expect(useMcpStore.getState().revision).toBe(revision);
    });

    it('drops malformed rows without losing the good ones', () => {
      useMcpStore.getState().applyCentrals([row({ centralId: 'a' }), { centralId: 'broken' }]);

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
    });

    it('knows a list that arrived over the socket means this window may start a central', () => {
      expect(useMcpStore.getState().available).toBeNull();

      useMcpStore.getState().applyCentrals([]);

      expect(useMcpStore.getState().available).toBe(true);
    });
  });

  describe('load', () => {
    let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

    beforeEach(() => {
      fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    /** Answers each URL the store asks for. */
    const answer = (routes: Record<string, () => Response | Promise<Response>>) => {
      fetchMock.mockImplementation(async (input) => {
        const handler = routes[String(input)];
        if (!handler) throw new Error(`Unexpected request: ${String(input)}`);
        return handler();
      });
    };

    it('reads the centrals and whether a password is set', async () => {
      answer({
        '/api/mcp/centrals': () => reply(200, { ok: true, centrals: [row({ centralId: 'a' })] }),
        '/api/auth/status': () => reply(200, { passwordRequired: false, authenticated: true }),
      });

      await useMcpStore.getState().load();

      const state = useMcpStore.getState();
      expect([...state.centrals.keys()]).toEqual(['a']);
      expect(state.available).toBe(true);
      expect(state.passwordEnabled).toBe(false);
    });

    it('reads a password that is set', async () => {
      answer({
        '/api/mcp/centrals': () => reply(200, { ok: true, centrals: [] }),
        '/api/auth/status': () => reply(200, { passwordRequired: true, authenticated: true }),
      });

      await useMcpStore.getState().load();

      expect(useMcpStore.getState().passwordEnabled).toBe(true);
    });

    it('is unavailable, with no centrals, when the server answers 404 (another device, or the feature off)', async () => {
      useMcpStore.setState({ centrals: new Map([['a', row({ centralId: 'a' })]]), available: true });
      answer({
        '/api/mcp/centrals': () => reply(404, { ok: false, error: 'Not found' }),
        '/api/auth/status': () => reply(200, { passwordRequired: true }),
      });

      await useMcpStore.getState().load();

      expect(useMcpStore.getState().available).toBe(false);
      expect(useMcpStore.getState().centrals.size).toBe(0);
    });

    it('keeps what it knew on 401, 403 and 429 too: a refusal of a sign-in says nothing about the feature', async () => {
      for (const status of [401, 403, 429]) {
        useMcpStore.setState({ ...INITIAL, centrals: new Map([['a', row({ centralId: 'a' })]]), available: true });
        answer({
          '/api/mcp/centrals': () => reply(status, { error: 'no' }),
          '/api/auth/status': () => reply(200, { passwordRequired: true }),
        });

        await useMcpStore.getState().load();

        expect(useMcpStore.getState().available).toBe(true);
        expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
      }
    });

    it('stays unknown (null) when the first answer is a 401', async () => {
      answer({
        '/api/mcp/centrals': () => reply(401, { error: 'no' }),
        '/api/auth/status': () => reply(200, { passwordRequired: true }),
      });

      await useMcpStore.getState().load();

      expect(useMcpStore.getState().available).toBeNull();
    });

    it('drops the activity rows of a central the read no longer lists', async () => {
      useMcpStore.setState({
        centrals: new Map([['a', row({ centralId: 'a' })], ['b', row({ centralId: 'b' })]]),
        available: true,
        activity: [
          { id: 2, at: 1, centralId: 'b', centralSessionId: null, tool: 't', risk: 'read', targetSessionId: null, taskId: null, summary: 's', outcome: 'ok', detail: null },
          { id: 1, at: 1, centralId: 'a', centralSessionId: null, tool: 't', risk: 'read', targetSessionId: null, taskId: null, summary: 's', outcome: 'ok', detail: null },
        ],
      });
      answer({
        '/api/mcp/centrals': () => reply(200, { ok: true, centrals: [row({ centralId: 'a' })] }),
        '/api/auth/status': () => reply(200, { passwordRequired: false }),
      });

      await useMcpStore.getState().load();

      expect(useMcpStore.getState().activity.map((r) => r.centralId)).toEqual(['a']);
    });

    it('keeps what it knew when the server fails (5xx) or cannot be reached', async () => {
      useMcpStore.setState({ centrals: new Map([['a', row({ centralId: 'a' })]]), available: true, passwordEnabled: true });
      answer({
        '/api/mcp/centrals': () => reply(503, {}),
        '/api/auth/status': () => reply(500, {}),
      });
      await useMcpStore.getState().load();
      expect(useMcpStore.getState().available).toBe(true);
      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
      expect(useMcpStore.getState().passwordEnabled).toBe(true);

      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(useMcpStore.getState().load()).resolves.toBeUndefined();
      expect(useMcpStore.getState().available).toBe(true);
      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
    });

    it('does not know about a password until the server says: an answer in an unknown shape leaves it null', async () => {
      answer({
        '/api/mcp/centrals': () => reply(200, { ok: true, centrals: [] }),
        '/api/auth/status': () => reply(200, { something: 'else' }),
      });

      await useMcpStore.getState().load();

      expect(useMcpStore.getState().passwordEnabled).toBeNull();
    });

    it('keeps the list read from a body that is not JSON out of the store (and does not throw)', async () => {
      answer({
        '/api/mcp/centrals': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response,
        '/api/auth/status': () => reply(200, { passwordRequired: false }),
      });

      await expect(useMcpStore.getState().load()).resolves.toBeUndefined();

      expect(useMcpStore.getState().available).toBeNull();
      expect(useMcpStore.getState().passwordEnabled).toBe(false);
    });

    it('throws away an answer that a newer centrals_update has overtaken', async () => {
      let release: (res: Response) => void = () => undefined;
      answer({
        '/api/mcp/centrals': () => new Promise<Response>((resolve) => { release = resolve; }),
        '/api/auth/status': () => reply(200, { passwordRequired: false }),
      });

      const loading = useMcpStore.getState().load();
      // While the read is in flight, a central starts and the socket says so.
      useMcpStore.getState().applyCentrals([row({ centralId: 'fresh' })]);
      release(reply(200, { ok: true, centrals: [] }));
      await loading;

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['fresh']);
    });

    it('takes the answer when nothing newer arrived', async () => {
      answer({
        '/api/mcp/centrals': () => reply(200, { ok: true, centrals: [row({ centralId: 'read' })] }),
        '/api/auth/status': () => reply(200, { passwordRequired: false }),
      });

      await useMcpStore.getState().load();

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['read']);
    });
  });
});
