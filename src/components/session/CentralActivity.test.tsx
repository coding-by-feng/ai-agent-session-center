/**
 * The activity panel of a central (server/mcp): a list of what it did, newest first: time · tool · target ·
 * outcome, with AASC's own one-line summary under each row. Every write the central made and every request
 * AASC refused is there, and so is every change of a task it handed out (tool `task`).
 *
 * It reads the log when it opens (GET /api/mcp/activity for its central) and then follows the `mcp_activity`
 * feed through the store, so a row that arrives while it is open is at the top at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CentralActivity from './CentralActivity';
import { useMcpStore } from '@/stores/mcpStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { McpActivityRow, Session } from '@/types';

const row = (over: Partial<McpActivityRow> = {}): McpActivityRow => ({
  id: 1,
  at: new Date(2026, 9, 24, 14, 5, 9).getTime(),
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

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({
    sessionId: id,
    title: `Worker ${id}`,
    projectName: 'proj',
    status: 'idle',
    startedAt: 1,
    lastActivityAt: 1,
    ...over,
  }) as unknown as Session;

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const NOW = new Date(2026, 9, 24, 18, 0, 0);

describe('CentralActivity', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    useMcpStore.setState({ activity: [] });
    useSessionStore.setState({
      sessions: new Map([
        ['w1', session('w1', { title: 'Backend worker' })],
        ['w2', session('w2', { title: '', projectName: 'web' })],
      ]),
    });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(200, { ok: true, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => {
      useMcpStore.setState({ activity: [] });
      useSessionStore.setState({ sessions: new Map() });
      useWsStore.setState({ connected: false, reconnecting: false, lastSeq: 0 });
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Serves these rows for the central's read. */
  const serve = (rows: McpActivityRow[]) => fetchMock.mockResolvedValue(reply(200, { ok: true, rows }));
  const items = () => screen.queryAllByRole('listitem');

  describe('reading the log', () => {
    it('reads this central’s rows when it opens', async () => {
      render(<CentralActivity centralId="c1" />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp/activity?limit=200&central=c1');
    });

    it('says it is loading until the read answers (when it holds no rows yet)', async () => {
      let release: (res: Response) => void = () => undefined;
      fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));

      render(<CentralActivity centralId="c1" />);

      expect(screen.getByText('Loading activity…')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

      await act(async () => release(reply(200, { ok: true, rows: [row()] })));

      await waitFor(() => expect(screen.queryByText('Loading activity…')).toBeNull());
      expect(items()).toHaveLength(1);
    });

    it('says it is loading again, not "no activity", while another central’s own read is out', async () => {
      const { rerender } = render(<CentralActivity centralId="c1" />);
      await screen.findByText('No activity yet');
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

      rerender(<CentralActivity centralId="c2" />);

      expect(screen.getByText('Loading activity…')).toBeInTheDocument();
      expect(screen.queryByText('No activity yet')).toBeNull();
    });

    it('says it is loading again, not the error, while a Retry’s read is out', async () => {
      fetchMock.mockResolvedValueOnce(reply(500));
      render(<CentralActivity centralId="c1" />);
      const retry = await screen.findByRole('button', { name: 'Retry' });
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

      fireEvent.click(retry);

      expect(screen.getByText('Loading activity…')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('reads again for another central when it is pointed at one', async () => {
      const { rerender } = render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      rerender(<CentralActivity centralId="c2" />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1][0]).toBe('/api/mcp/activity?limit=200&central=c2');
    });
  });

  // The feed is never replayed: a row the central wrote while the socket was down reaches the store only through a
  // read. The tab reads when it opens, so a tab that stays open across a drop would never list those rows.
  describe('after a reconnect', () => {
    beforeEach(() => {
      useWsStore.setState({ connected: true });
    });

    // The rows the central wrote while the socket was down are listed once the socket is back.
    it('ACTIVITY re-reads after a reconnect', async () => {
      serve([row({ id: 1, summary: 'first' })]);
      render(<CentralActivity centralId="c1" />);
      await screen.findByText('first');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      act(() => useWsStore.setState({ connected: false }));
      serve([row({ id: 2, summary: 'written while it was down' }), row({ id: 1, summary: 'first' })]);
      act(() => useWsStore.setState({ connected: true }));

      expect(await screen.findByText('written while it was down')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/mcp/activity?limit=200&central=c1');
    });

    it('reads again at every reconnect, not only the first', async () => {
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      for (let n = 2; n <= 3; n += 1) {
        act(() => useWsStore.setState({ connected: false }));
        act(() => useWsStore.setState({ connected: true }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(n));
      }
    });

    it('does not read while the socket is down, only when it is back', async () => {
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      act(() => useWsStore.setState({ connected: false }));
      act(() => useWsStore.setState({ reconnecting: true }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not read again for a change of the socket state that is not a reconnect (it stays up)', async () => {
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      act(() => useWsStore.setState({ lastSeq: 5 }));
      act(() => useWsStore.setState({ connected: true }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the list on screen while it reads again (no "Loading" over rows already shown)', async () => {
      serve([row({ id: 1, summary: 'first' })]);
      render(<CentralActivity centralId="c1" />);
      await screen.findByText('first');
      fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

      act(() => useWsStore.setState({ connected: false }));
      act(() => useWsStore.setState({ connected: true }));

      expect(screen.getByText('first')).toBeInTheDocument();
      expect(screen.queryByText('Loading activity…')).toBeNull();
    });

    it('reads for the central it shows now, after it was pointed at another one', async () => {
      const { rerender } = render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      rerender(<CentralActivity centralId="c2" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      act(() => useWsStore.setState({ connected: false }));
      act(() => useWsStore.setState({ connected: true }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(fetchMock.mock.calls[2][0]).toBe('/api/mcp/activity?limit=200&central=c2');
    });

    it('stops listening when it closes (no read for a tab that is gone)', async () => {
      const { unmount } = render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      unmount();
      act(() => useWsStore.setState({ connected: false }));
      act(() => useWsStore.setState({ connected: true }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('says the older rows could not be loaded when the read after a reconnect fails, with the rows it has still shown', async () => {
      serve([row({ id: 1, summary: 'first' })]);
      render(<CentralActivity centralId="c1" />);
      await screen.findByText('first');
      fetchMock.mockResolvedValue(reply(500));

      act(() => useWsStore.setState({ connected: false }));
      act(() => useWsStore.setState({ connected: true }));

      expect(await screen.findByText(/older rows/i)).toBeInTheDocument();
      expect(screen.getByText('first')).toBeInTheDocument();
    });

    it('reads when the socket comes up after the tab opened while it was down', async () => {
      useWsStore.setState({ connected: false });
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      act(() => useWsStore.setState({ connected: true }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });
  });

  describe('the list', () => {
    it('shows this central’s rows only, newest first', async () => {
      serve([
        row({ id: 3, summary: 'third' }),
        row({ id: 2, centralId: 'c2', summary: 'another central’s' }),
        row({ id: 1, summary: 'first' }),
      ]);

      render(<CentralActivity centralId="c1" />);

      await waitFor(() => expect(items()).toHaveLength(2));
      expect(items().map((li) => li.textContent)).toEqual([
        expect.stringContaining('third'),
        expect.stringContaining('first'),
      ]);
      expect(screen.queryByText('another central’s')).toBeNull();
    });

    it('is a list, with a row for each entry', async () => {
      serve([row({ id: 2 }), row({ id: 1 })]);

      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByRole('list')).toBeInTheDocument();
      expect(items()).toHaveLength(2);
    });

    it('shows a row’s time, tool, target and outcome, and AASC’s summary under them', async () => {
      serve([row({ tool: 'task_delegate', summary: 'Gave a task to 1 session', outcome: 'ok' })]);

      render(<CentralActivity centralId="c1" />);

      const li = (await screen.findAllByRole('listitem'))[0];
      expect(within(li).getByText('14:05:09')).toBeInTheDocument();
      expect(within(li).getByText('task_delegate')).toBeInTheDocument();
      expect(within(li).getByText('Backend worker')).toBeInTheDocument();
      expect(within(li).getByText('ok')).toBeInTheDocument();
      expect(within(li).getByText('Gave a task to 1 session')).toBeInTheDocument();
    });

    it('gives the whole tool name and what kind of call it is on hover, for a name the column cut short', async () => {
      serve([row({ tool: 'queue_set_item_schedule', risk: 'write' })]);

      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByText('queue_set_item_schedule')).toHaveAttribute('title', 'queue_set_item_schedule (write)');
    });

    it('gives the time as a machine-readable <time>, with the full date on hover', async () => {
      serve([row()]);

      render(<CentralActivity centralId="c1" />);

      const time = (await screen.findByText('14:05:09')).closest('time');
      expect(time).not.toBeNull();
      expect(time?.getAttribute('datetime')).toBe(new Date(2026, 9, 24, 14, 5, 9).toISOString());
      expect(time?.getAttribute('title')).toContain('2026');
    });

    it('adds the day to the time of an older row', async () => {
      serve([row({ at: new Date(2026, 9, 22, 9, 30, 0).getTime() })]);

      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByText('Oct 22 09:30')).toBeInTheDocument();
    });

    // The store accepts any finite number as a row's time, and a finite number can be out of range for a Date
    // (`new Date(1e20).toISOString()` throws a RangeError). One such row must not take the whole panel down.
    it('an out-of-range row time renders "—" instead of throwing', async () => {
      serve([row({ id: 2, at: 1e20, summary: 'a row with an odd time' }), row({ id: 1, summary: 'a row with a fine one' })]);

      const { container } = render(<CentralActivity centralId="c1" />);

      const lis = await screen.findAllByRole('listitem');
      expect(lis).toHaveLength(2);
      const odd = container.querySelectorAll('time')[0];
      expect(odd).toHaveTextContent('—');
      expect(odd).not.toHaveAttribute('datetime');
      // The other row is untouched, and so is the rest of the panel.
      expect(within(lis[1]).getByText('14:05:09')).toBeInTheDocument();
      expect(screen.getByText('a row with an odd time')).toBeInTheDocument();
    });

    it('renders "—" for a negative out-of-range time too, and keeps a row at the edge of the range', async () => {
      serve([
        row({ id: 3, at: -1e20, summary: 'far before' }),
        row({ id: 2, at: 8.64e15, summary: 'the last moment a Date holds' }),
        row({ id: 1, at: 8.64e15 + 1, summary: 'one past it' }),
      ]);

      const { container } = render(<CentralActivity centralId="c1" />);

      await screen.findAllByRole('listitem');
      const [before, edge, past] = Array.from(container.querySelectorAll('time'));
      expect(before).toHaveTextContent('—');
      expect(edge).not.toHaveTextContent('—');
      expect(edge).toHaveAttribute('datetime');
      expect(past).toHaveTextContent('—');
      expect(past).not.toHaveAttribute('datetime');
    });

    it('names the target as its card does, and follows a rename', async () => {
      serve([row({ targetSessionId: 'w2' })]);
      render(<CentralActivity centralId="c1" />);
      expect(await screen.findByText('web')).toBeInTheDocument();

      act(() => useSessionStore.getState().updateSession(session('w2', { title: 'Web worker' })));

      expect(screen.getByText('Web worker')).toBeInTheDocument();
      expect(screen.queryByText('web')).toBeNull();
    });

    it('shows a short id for a target that is not on the board any more, and the whole id on hover', async () => {
      serve([row({ targetSessionId: '0123456789abcdef' })]);

      render(<CentralActivity centralId="c1" />);

      const target = await screen.findByText('01234567');
      expect(target).toHaveAttribute('title', '0123456789abcdef');
    });

    it('shows a dash for a row with no target (a refusal before any session was named)', async () => {
      serve([row({ targetSessionId: null, outcome: 'refused', summary: 'Refused: too many targets' })]);

      render(<CentralActivity centralId="c1" />);

      const li = (await screen.findAllByRole('listitem'))[0];
      expect(within(li).getByText('—')).toBeInTheDocument();
    });

    it('tells a refusal apart from a success by its word and its tone', async () => {
      serve([
        row({ id: 3, outcome: 'failed', summary: 'The prompt route failed' }),
        row({ id: 2, outcome: 'refused', summary: 'Refused: that session is hands-off' }),
        row({ id: 1, outcome: 'ok' }),
      ]);

      render(<CentralActivity centralId="c1" />);

      const lis = await screen.findAllByRole('listitem');
      const chip = (li: HTMLElement, word: string) => within(li).getByText(word);
      expect(chip(lis[0], 'failed').className).toMatch(/danger/);
      expect(chip(lis[1], 'refused').className).toMatch(/warning/);
      expect(chip(lis[2], 'ok').className).toMatch(/success/);
    });

    it('lists a task’s changes of state beside the writes (tool task, the state as its outcome)', async () => {
      serve([row({ id: 2, tool: 'task', outcome: 'blocked', taskId: 'T12', summary: 'T12 blocked: the session waits on a dialog' })]);

      render(<CentralActivity centralId="c1" />);

      const li = (await screen.findAllByRole('listitem'))[0];
      expect(within(li).getByText('task')).toBeInTheDocument();
      expect(within(li).getByText('blocked').className).toMatch(/warning/);
    });

    it('shows text a row holds as text, never as markup', async () => {
      serve([row({ summary: '<img src=x onerror=alert(1)> and <b>bold</b>' })]);

      const { container } = render(<CentralActivity centralId="c1" />);

      await screen.findAllByRole('listitem');
      expect(container.querySelector('img, b')).toBeNull();
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('puts a row that arrives over the feed at the top at once', async () => {
      serve([row({ id: 1, summary: 'first' })]);
      render(<CentralActivity centralId="c1" />);
      await screen.findAllByRole('listitem');

      act(() => useMcpStore.getState().applyActivityRow(row({ id: 2, summary: 'second, live' })));

      expect(items().map((li) => li.textContent)).toEqual([
        expect.stringContaining('second, live'),
        expect.stringContaining('first'),
      ]);
    });

    it('does not show a live row of another central', async () => {
      serve([row({ id: 1 })]);
      render(<CentralActivity centralId="c1" />);
      await screen.findAllByRole('listitem');

      act(() => useMcpStore.getState().applyActivityRow(row({ id: 2, centralId: 'c2', summary: 'not mine' })));

      expect(items()).toHaveLength(1);
      expect(screen.queryByText('not mine')).toBeNull();
    });

    it('holds nothing focusable: it is a record to read, not a control', async () => {
      serve([row({ id: 2 }), row({ id: 1 })]);

      const { container } = render(<CentralActivity centralId="c1" />);

      await screen.findAllByRole('listitem');
      expect(container.querySelectorAll('button, a, input, select, [tabindex]')).toHaveLength(0);
    });
  });

  describe('when there is nothing to show', () => {
    it('says so, and what will appear, after a read that found no rows', async () => {
      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByText('No activity yet')).toBeInTheDocument();
      expect(screen.getByText(/refuses/i)).toBeInTheDocument();
      expect(screen.queryByRole('list')).toBeNull();
    });

    it('leaves the empty note when a row arrives', async () => {
      render(<CentralActivity centralId="c1" />);
      await screen.findByText('No activity yet');

      act(() => useMcpStore.getState().applyActivityRow(row({ id: 1 })));

      expect(screen.queryByText('No activity yet')).toBeNull();
      expect(items()).toHaveLength(1);
    });
  });

  describe('when the log cannot be read', () => {
    it.each([404, 403, 500])('says so, as an error with a Retry, after a %s (and holds no rows)', async (status) => {
      fetchMock.mockResolvedValue(reply(status));

      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the activity log.');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('says so after a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      render(<CentralActivity centralId="c1" />);

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });

    it('reads again on Retry, and lists what it finds', async () => {
      fetchMock.mockResolvedValueOnce(reply(500));
      render(<CentralActivity centralId="c1" />);
      const retry = await screen.findByRole('button', { name: 'Retry' });
      serve([row({ summary: 'found on the second try' })]);
      fireEvent.click(retry);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      expect(await screen.findByText('found on the second try')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the rows the feed brought while it could not read, with a note and a Retry beneath them', async () => {
      fetchMock.mockResolvedValue(reply(500));
      render(<CentralActivity centralId="c1" />);
      await screen.findByRole('alert');

      act(() => useMcpStore.getState().applyActivityRow(row({ id: 5, summary: 'live row' })));

      expect(screen.getByText('live row')).toBeInTheDocument();
      expect(screen.getByText(/older rows/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  describe('a read that is overtaken', () => {
    it('does not let a late answer for the old central decide what the new one shows', async () => {
      let releaseFirst: (res: Response) => void = () => undefined;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }));
      const { rerender } = render(<CentralActivity centralId="c1" />);

      rerender(<CentralActivity centralId="c2" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await act(async () => releaseFirst(reply(500)));

      // The first read failed, but it was for c1: c2 shows what its own read found.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    });

    // The first read and the one after a reconnect share a key: the answer of the older must not decide over the newer.
    it('an older read that fails after a newer one answered does not put the error over the fresh rows', async () => {
      act(() => useWsStore.setState({ connected: false }));
      let failFirst: (res: Response) => void = () => undefined;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { failFirst = resolve; }));
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      serve([row({ id: 2, summary: 'fresh' })]);
      act(() => useWsStore.setState({ connected: true })); // the reconnect read
      expect(await screen.findByText('fresh')).toBeInTheDocument();
      await act(async () => failFirst(reply(500)));

      expect(screen.getByText('fresh')).toBeInTheDocument();
      expect(screen.queryByText(/older rows/i)).toBeNull();
    });

    it('an older read that succeeds after a newer one failed does not hide that failure', async () => {
      act(() => useWsStore.setState({ connected: false }));
      let releaseFirst: (res: Response) => void = () => undefined;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }));
      render(<CentralActivity centralId="c1" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      fetchMock.mockResolvedValue(reply(500));
      act(() => useWsStore.setState({ connected: true }));
      await screen.findByRole('alert'); // the newer read failed, and nothing is held
      await act(async () => releaseFirst(reply(200, { ok: true, rows: [row({ id: 3, summary: 'late' })] })));

      expect(await screen.findByText('late')).toBeInTheDocument();
      expect(screen.getByText(/older rows/i)).toBeInTheDocument();
    });
  });
});
