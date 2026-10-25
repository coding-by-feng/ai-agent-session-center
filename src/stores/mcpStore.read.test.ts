/**
 * How mcpStore reads the server (P2): GET /api/mcp/tasks when the socket connects (`loadTasks`) and GET
 * /api/mcp/activity when a central's panel opens (`loadActivity`). Whatever those reads come to, the store keeps
 * only the public fields, and a read that fails or is refused says nothing about what the store already holds,
 * except a 404 for the tasks: that says the ledger is not here, so no open task held can still be running.
 *
 * The reducers they feed are in mcpStore.feed.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMcpStore } from './mcpStore';
import type { McpActivityRow, McpTaskView } from '@/types';

const task = (over: Partial<McpTaskView> = {}): McpTaskView => ({
  taskId: 'T1',
  centralId: 'c1',
  sessionId: 'w1',
  state: 'running',
  title: 'fix the flaky queue test',
  createdAt: 1_000,
  sentAt: 1_100,
  updatedAt: 2_000,
  error: null,
  answerChars: null,
  ...over,
});

const row = (over: Partial<McpActivityRow> = {}): McpActivityRow => ({
  id: 1,
  at: 1_700_000_000_000,
  centralId: 'c1',
  centralSessionId: 'central-card',
  tool: 'prompt_send',
  risk: 'steers',
  targetSessionId: 'w1',
  taskId: null,
  summary: 'Sent a prompt to 1 session',
  outcome: 'ok',
  detail: null,
  ...over,
});

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const INITIAL = {
  centrals: new Map(),
  available: null,
  passwordEnabled: null,
  revision: 0,
  tasks: new Map<string, McpTaskView>(),
  activity: [] as McpActivityRow[],
  taskRevision: 0,
};

beforeEach(() => {
  useMcpStore.setState(INITIAL);
});

// ---------------------------------------------------------------------------

describe('reading over HTTP', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Answers each URL (path and query) the store asks for. */
  const answer = (routes: Record<string, () => Response | Promise<Response>>) => {
    fetchMock.mockImplementation(async (input) => {
      const handler = routes[String(input)];
      if (!handler) throw new Error(`Unexpected request: ${String(input)}`);
      return handler();
    });
  };

  describe('loadTasks', () => {
    it('reads the tasks in flight into the store', async () => {
      answer({ '/api/mcp/tasks': () => reply(200, { ok: true, tasks: [task({ taskId: 'T4' })] }) });

      await useMcpStore.getState().loadTasks();

      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T4']);
    });

    it('drops an open task the server no longer has (a reconnect after the task ended)', async () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'running' }));
      answer({ '/api/mcp/tasks': () => reply(200, { ok: true, tasks: [] }) });

      await useMcpStore.getState().loadTasks();

      expect(useMcpStore.getState().tasks.size).toBe(0);
    });

    it('keeps what it held when the server refuses a sign-in (401, 403), fails, or cannot be reached: that says nothing about the tasks', async () => {
      useMcpStore.getState().applyTaskUpdate(task());
      for (const status of [401, 403, 500, 503]) {
        answer({ '/api/mcp/tasks': () => reply(status, {}) });
        await useMcpStore.getState().loadTasks();
      }
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(useMcpStore.getState().loadTasks()).resolves.toBeUndefined();

      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1']);
    });

    // A 404 says the ledger that held these tasks is not there: central sessions were switched off in
    // server-config.json and the server restarted, or this is a device that may not see them. Nothing held can
    // still be running, so no worker badge may go on saying it is.
    it('a 404 tasks read clears held running tasks', async () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'running' }));
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2', state: 'blocked' }));
      answer({ '/api/mcp/tasks': () => reply(404, { ok: false, error: 'Not found' }) });

      await useMcpStore.getState().loadTasks();

      expect(useMcpStore.getState().tasks.size).toBe(0);
    });

    it('a 404 keeps the tasks that ended, as every read does (the store mirrors the feed)', async () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'running' }));
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2', state: 'done', updatedAt: 3_000 }));
      answer({ '/api/mcp/tasks': () => reply(404, { ok: false, error: 'Not found' }) });

      await useMcpStore.getState().loadTasks();

      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T2']);
    });

    it('a 404 is an answer, not a race: one read, even when a live change landed while it was out', async () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'running' }));
      fetchMock.mockImplementation(async () => {
        useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2', updatedAt: 9_000 }));
        return reply(404, { ok: false, error: 'Not found' });
      });

      await useMcpStore.getState().loadTasks();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(useMcpStore.getState().tasks.has('T1')).toBe(false);
    });

    it('does not throw for a body that is not JSON, or has no list', async () => {
      answer({ '/api/mcp/tasks': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response });
      await expect(useMcpStore.getState().loadTasks()).resolves.toBeUndefined();
      answer({ '/api/mcp/tasks': () => reply(200, { ok: true }) });
      await expect(useMcpStore.getState().loadTasks()).resolves.toBeUndefined();
      expect(useMcpStore.getState().tasks.size).toBe(0);
    });

    it('reads again when a change arrived while it was in flight, so no live change is lost to an older list', async () => {
      let release: (res: Response) => void = () => undefined;
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        // The first read is held; the second answers at once, with the task the first never knew.
        if (calls === 1) return new Promise<Response>((resolve) => { release = resolve; });
        return reply(200, { ok: true, tasks: [task({ taskId: 'T9', sessionId: 'w9', updatedAt: 5_000 })] });
      });

      const loading = useMcpStore.getState().loadTasks();
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T9', sessionId: 'w9', state: 'sent', updatedAt: 4_000 }));
      release(reply(200, { ok: true, tasks: [] }));
      await loading;

      expect(calls).toBe(2);
      expect(useMcpStore.getState().tasks.get('T9')?.state).toBe('running');
    });

    it('gives up after a few tries when changes keep arriving, and never loops for ever', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        // A change lands during every read.
        useMcpStore.getState().applyTaskUpdate(task({ taskId: `T${calls}`, sessionId: `w${calls}`, updatedAt: calls }));
        return reply(200, { ok: true, tasks: [] });
      });

      await useMcpStore.getState().loadTasks();

      expect(calls).toBeLessThanOrEqual(3);
    });

    // Giving up must not leave the window as it was: a task that ended while it was away would show "running" until
    // the next reconnect. The last list is the best there is, so it is applied; a task a live change brought or moved
    // while that read was out is newer than the list, which could not know it, so that one stays.
    it('applies the last list when it gives up, and keeps what a live change brought during that read', async () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T0', sessionId: 'w0', state: 'running', updatedAt: 100 }));
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        useMcpStore.getState().applyTaskUpdate(task({ taskId: `T${calls}`, sessionId: `w${calls}`, updatedAt: 1_000 + calls }));
        return reply(200, { ok: true, tasks: [] });
      });

      await useMcpStore.getState().loadTasks();

      expect(calls).toBe(3);
      // T0 ended while the window was away (no list ever has it); T1 and T2 were held when the last read began and
      // the list omits them; T3 landed during that read.
      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T3']);
    });

    it('applies the last list’s own tasks when it gives up', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        useMcpStore.getState().applyTaskUpdate(task({ taskId: `T${calls}`, sessionId: `w${calls}`, updatedAt: 1_000 + calls }));
        return reply(200, { ok: true, tasks: [task({ taskId: 'T77', sessionId: 'w77', updatedAt: 500 })] });
      });

      await useMcpStore.getState().loadTasks();

      expect(useMcpStore.getState().tasks.has('T77')).toBe(true);
    });

    it('takes the last list’s version of a task a live change also touched, when the list is the newer', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        // A live change lands during every read; the list (computed after it) already has the task's next state.
        useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T5', sessionId: 'w5', state: 'sent', updatedAt: 1_000 + calls }));
        return reply(200, { ok: true, tasks: [task({ taskId: 'T5', sessionId: 'w5', state: 'running', updatedAt: 5_000 })] });
      });

      await useMcpStore.getState().loadTasks();

      expect(calls).toBe(3);
      expect(useMcpStore.getState().tasks.get('T5')?.state).toBe('running');
    });

    it('keeps the live version of a task when it is newer than the last list’s', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T5', sessionId: 'w5', state: 'blocked', updatedAt: 9_000 + calls }));
        return reply(200, { ok: true, tasks: [task({ taskId: 'T5', sessionId: 'w5', state: 'running', updatedAt: 5_000 })] });
      });

      await useMcpStore.getState().loadTasks();

      expect(calls).toBe(3);
      expect(useMcpStore.getState().tasks.get('T5')?.state).toBe('blocked');
    });

    it('does not apply a list it threw away to try again (only the last one counts)', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async () => {
        calls += 1;
        // Overtaken by a live change the first time, clean the second.
        if (calls === 1) {
          useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T9', sessionId: 'w9', updatedAt: 2_000 }));
          return reply(200, { ok: true, tasks: [task({ taskId: 'T-old', sessionId: 'w-old', updatedAt: 100 })] });
        }
        return reply(200, { ok: true, tasks: [task({ taskId: 'T9', sessionId: 'w9', updatedAt: 2_000 })] });
      });

      await useMcpStore.getState().loadTasks();

      expect(calls).toBe(2);
      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T9']);
    });
  });

  describe('loadActivity', () => {
    it('reads a central’s rows into the store, and says it got a list', async () => {
      answer({
        '/api/mcp/activity?limit=200&central=c1': () => reply(200, { ok: true, rows: [row({ id: 2 }), row({ id: 1 })] }),
      });

      const got = await useMcpStore.getState().loadActivity('c1');

      expect(got).toBe(true);
      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([2, 1]);
    });

    it('asks for every central’s rows when it is given no central', async () => {
      answer({ '/api/mcp/activity?limit=200': () => reply(200, { ok: true, rows: [row({ id: 1 })] }) });

      expect(await useMcpStore.getState().loadActivity()).toBe(true);
    });

    it('names the central in the query, encoded', async () => {
      answer({ '/api/mcp/activity?limit=200&central=a%20b%26c': () => reply(200, { ok: true, rows: [] }) });

      expect(await useMcpStore.getState().loadActivity('a b&c')).toBe(true);
    });

    it('merges with the rows the socket brought meanwhile, each row once', async () => {
      useMcpStore.getState().applyActivityRow(row({ id: 3 }));
      answer({ '/api/mcp/activity?limit=200&central=c1': () => reply(200, { ok: true, rows: [row({ id: 3 }), row({ id: 2 })] }) });

      await useMcpStore.getState().loadActivity('c1');

      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([3, 2]);
    });

    it('answers false and keeps what it held for a refusal or a failure', async () => {
      useMcpStore.getState().applyActivityRow(row({ id: 1 }));
      for (const status of [404, 401, 403, 500]) {
        answer({ '/api/mcp/activity?limit=200&central=c1': () => reply(status, {}) });
        expect(await useMcpStore.getState().loadActivity('c1')).toBe(false);
      }
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      expect(await useMcpStore.getState().loadActivity('c1')).toBe(false);

      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([1]);
    });

    it('answers false for a body with no list, or that is not JSON, and never throws', async () => {
      answer({ '/api/mcp/activity?limit=200&central=c1': () => reply(200, { ok: true }) });
      expect(await useMcpStore.getState().loadActivity('c1')).toBe(false);
      answer({
        '/api/mcp/activity?limit=200&central=c1': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response,
      });
      expect(await useMcpStore.getState().loadActivity('c1')).toBe(false);
    });

    it('holds only the public fields of what the server sent', async () => {
      answer({
        '/api/mcp/activity?limit=200&central=c1': () =>
          reply(200, { ok: true, rows: [{ ...row({ id: 1 }), token: 'aasc_mcp_SECRET', terminalId: 'term-1' }] }),
      });

      await useMcpStore.getState().loadActivity('c1');

      expect(JSON.stringify(useMcpStore.getState().activity)).not.toContain('SECRET');
      expect(useMcpStore.getState().activity[0]).not.toHaveProperty('token');
    });
  });
});
