// Click a subagent card in the AGENTS tab → its own task, messages, tool calls and result,
// read from its transcript. Rendered through AgentsTab, which owns the card ↔ detail swap.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SubagentRun } from '@/types';
import type { ConversationEntry } from '@/lib/transcript';
import type { SubagentTranscriptPage } from '@/lib/subagentTranscript';
import { useSessionStore } from '@/stores/sessionStore';
import AgentsTab from './AgentsTab';
import { REFRESH_DEBOUNCE_MS } from './SubagentDetail';

vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: vi.fn(),
}));

const T0 = 1_791_000_000_000;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id, status: 'working', animationState: 'Idle', emote: null,
    projectName: 'agent-manager', projectPath: '/tmp/agent-manager', title: `Session ${id}`,
    source: 'terminal', model: 'claude-opus-5-5', startedAt: T0, lastActivityAt: T0, endedAt: null,
    currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0, toolLog: [],
    responseLog: [], events: [], pendingTool: null, waitingDetail: null, subagentCount: 0,
    terminalId: null, cachedPid: null, archived: 0, queueCount: 0, cliSource: 'claude',
    ...overrides,
  };
}

function makeRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    agentId: 'a1', agentType: 'aasc20-rooms', description: 'AASC-20 rooms sync for phones', descriptionConfirmed: true,
    status: 'working', startedAt: T0 + 10, endedAt: null, lastActivityAt: T0 + 10, toolCount: 2,
    currentTool: 'Bash', currentTarget: 'npm test', ...over,
  };
}

function seed(...sessions: Session[]) {
  useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])), selectedSessionId: null });
}

const page = (over: Partial<SubagentTranscriptPage> = {}): SubagentTranscriptPage => ({
  task: 'Build the TypeScript (web-side) logic of the AASC phone app',
  entries: [
    { role: 'assistant', text: 'I will start by reading the rooms code.', timestamp: T0 + 20 },
    { role: 'tool_use', tool: 'Read', input: '{"file_path":"/x/src/lib/roomSync.ts"}', timestamp: T0 + 21, id: 't1' },
    { role: 'tool_result', output: 'export function syncRooms() {}', timestamp: T0 + 22, toolUseId: 't1', isError: false },
    { role: 'tool_use', tool: 'Bash', input: '{"command":"npm test"}', timestamp: T0 + 23, id: 't2' },
    { role: 'tool_result', output: '1 failed', timestamp: T0 + 24, toolUseId: 't2', isError: true },
  ] as ConversationEntry[],
  start: 500,
  hasEarlier: false,
  ...over,
});

type Responder = (url: string) => unknown;
let calls: string[] = [];
function serve(respond: Responder) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = respond(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify({ success: true, data: body }));
  }));
}

async function openCard(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name }));
  return user;
}

describe('AGENTS tab — open a subagent', () => {
  beforeEach(() => {
    seed(makeSession('L', { subagents: [makeRun()] }));
    serve(() => page());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a subagent card is a button; the leader card is not', () => {
    render(<AgentsTab sessionId="L" />);
    expect(screen.getByRole('button', { name: /aasc20-rooms, subagent, working/i })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Session L, leader/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Session L, leader/i })).toBeNull();
  });

  it('clicking it shows that agent in place of the diagram and the log', async () => {
    render(<AgentsTab sessionId="L" />);
    await openCard(/aasc20-rooms, subagent/i);
    const detail = screen.getByRole('region', { name: 'aasc20-rooms' });
    expect(screen.queryByRole('region', { name: /agent diagram/i })).toBeNull();
    expect(screen.queryByRole('table', { name: /agent activity/i })).toBeNull();
    expect(within(detail).getByText('AASC-20 rooms sync for phones')).toBeTruthy();
    expect(await within(detail).findByText(/Build the TypeScript \(web-side\) logic/)).toBeTruthy();
    expect(within(detail).getByText('I will start by reading the rooms code.')).toBeTruthy();
    expect(calls[0]).toBe('/api/sessions/L/subagents/a1/transcript');
  });

  it('moves focus to Back, and Back (or Esc) returns to the card it came from', async () => {
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    const back = screen.getByRole('button', { name: /back to all agents/i });
    expect(document.activeElement).toBe(back);
    await user.click(back);
    expect(screen.getByRole('region', { name: /agent diagram/i })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /aasc20-rooms, subagent/i }));

    await user.click(screen.getByRole('button', { name: /aasc20-rooms, subagent/i }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('region', { name: /agent diagram/i })).toBeTruthy();
  });

  it('Esc in the detail does not reach the panel\'s own Escape handling', async () => {
    const onWindowEsc = vi.fn();
    window.addEventListener('keydown', onWindowEsc);
    try {
      render(<AgentsTab sessionId="L" />);
      const user = await openCard(/aasc20-rooms, subagent/i);
      await user.keyboard('{Escape}');
      expect(onWindowEsc).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowEsc);
    }
  });

  it('each tool call is one row naming what it did, and opens to its input and output', async () => {
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    const read = await screen.findByRole('button', { name: /Read \/x\/src\/lib\/roomSync\.ts/ });
    expect(read.getAttribute('aria-expanded')).toBe('false');
    await user.click(read);
    expect(read.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('export function syncRooms() {}')).toBeTruthy();
    expect(screen.getByText('file_path: /x/src/lib/roomSync.ts')).toBeTruthy();
  });

  it('marks a failed call with a word, not colour alone', async () => {
    render(<AgentsTab sessionId="L" />);
    await openCard(/aasc20-rooms, subagent/i);
    const bash = await screen.findByRole('button', { name: /Bash npm test/ });
    expect(within(bash.closest('li')!).getByLabelText('failed')).toBeTruthy();
  });

  it('"Replies" hides the tool calls', async () => {
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    await screen.findByRole('button', { name: /Read \/x/ });
    await user.click(screen.getByRole('button', { name: 'Replies' }));
    expect(screen.queryByRole('button', { name: /Read \/x/ })).toBeNull();
    expect(screen.getByText('I will start by reading the rooms code.')).toBeTruthy();
  });

  it('shows the result once the agent is done, and not again in the messages', async () => {
    seed(makeSession('L', { subagents: [makeRun({ status: 'done', endedAt: T0 + 90, currentTool: null })] }));
    serve(() => page({ entries: [...page().entries, { role: 'assistant', text: 'Rooms now sync to phones.', timestamp: T0 + 80 }] }));
    render(<AgentsTab sessionId="L" />);
    await openCard(/aasc20-rooms, subagent, done/i);
    const result = await screen.findByRole('region', { name: 'Result' });
    expect(within(result).getByText('Rooms now sync to phones.')).toBeTruthy();
    expect(screen.getAllByText('Rooms now sync to phones.')).toHaveLength(1);
  });

  it('"Load earlier" asks for the page above and puts it on top', async () => {
    serve((url) => (url.includes('before=500')
      ? page({ entries: [{ role: 'assistant', text: 'The very first reply.', timestamp: T0 + 11 }], start: 200, hasEarlier: false })
      : page({ hasEarlier: true })));
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    await user.click(await screen.findByRole('button', { name: /load earlier/i }));
    expect(await screen.findByText('The very first reply.')).toBeTruthy();
    expect(calls).toContain('/api/sessions/L/subagents/a1/transcript?before=500');
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('The very first reply.');
    // The button is gone with nothing above: focus stays in the view, so Esc still goes back.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'aasc20-rooms' })));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('region', { name: /agent diagram/i })).toBeTruthy();
  });

  it('fetches again when the agent makes another call, from where the loaded pages end', async () => {
    serve((url) => (url.includes('before=') ? page({ entries: [], start: 100, hasEarlier: false }) : page({ hasEarlier: true })));
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    await user.click(await screen.findByRole('button', { name: /load earlier/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => {
      seed(makeSession('L', { subagents: [makeRun({ toolCount: 3, lastActivityAt: T0 + 30 })] }));
    });
    await waitFor(() => expect(calls).toHaveLength(3), { timeout: REFRESH_DEBOUNCE_MS + 2000 });
    expect(calls[2]).toBe('/api/sessions/L/subagents/a1/transcript?from=500');
  });

  it('a refresh already on its way when "Load earlier" lands leaves no gap: it is asked again from the loaded top', async () => {
    let releaseRefresh: (() => void) | null = null;
    calls = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      n += 1;
      const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
      if (url.includes('before=500')) return reply(page({ entries: [{ role: 'assistant', text: 'older', timestamp: T0 + 11 }], start: 100, hasEarlier: false }));
      if (url.includes('from=500')) return reply(page({ start: 500 }));
      if (n === 1) return reply(page({ hasEarlier: true }));
      // The newest-page refresh: held until "Load earlier" has landed; the file grew meanwhile.
      await new Promise<void>((r) => { releaseRefresh = r; });
      return reply(page({ start: 700, hasEarlier: true }));
    }));
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    await screen.findByRole('button', { name: /load earlier/i });
    act(() => {
      seed(makeSession('L', { subagents: [makeRun({ toolCount: 3, lastActivityAt: T0 + 30 })] }));
    });
    await waitFor(() => expect(releaseRefresh).not.toBeNull(), { timeout: REFRESH_DEBOUNCE_MS + 2000 });
    await user.click(screen.getByRole('button', { name: /load earlier/i }));
    expect(await screen.findByText('older')).toBeTruthy();
    act(() => releaseRefresh!());
    await waitFor(() => expect(calls.some((c) => c.endsWith('?from=500'))).toBe(true), { timeout: REFRESH_DEBOUNCE_MS + 2000 });
    expect(screen.getByText('older')).toBeTruthy();
  });

  it('"Load earlier" that loses the race to a refresh asks again from the new top, not dropping its page', async () => {
    let releaseEarlier: (() => void) | null = null;
    calls = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      n += 1;
      const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
      if (url.includes('before=500')) {
        await new Promise<void>((r) => { releaseEarlier = r; });
        return reply(page({ entries: [{ role: 'assistant', text: 'stale older', timestamp: T0 + 11 }], start: 100, hasEarlier: false }));
      }
      if (url.includes('before=700')) return reply(page({ entries: [{ role: 'assistant', text: 'joined older', timestamp: T0 + 12 }], start: 300, hasEarlier: false }));
      if (n === 1) return reply(page({ hasEarlier: true }));
      return reply(page({ start: 700, hasEarlier: true }));
    }));
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    await user.click(await screen.findByRole('button', { name: /load earlier/i }));
    await waitFor(() => expect(releaseEarlier).not.toBeNull());
    act(() => {
      seed(makeSession('L', { subagents: [makeRun({ toolCount: 3, lastActivityAt: T0 + 30 })] }));
    });
    await waitFor(() => expect(calls).toHaveLength(3), { timeout: REFRESH_DEBOUNCE_MS + 2000 });
    act(() => releaseEarlier!());
    expect(await screen.findByText('joined older')).toBeTruthy();
    expect(screen.queryByText('stale older')).toBeNull();
    expect(calls).toContain('/api/sessions/L/subagents/a1/transcript?before=700');
  });

  it('without a transcript, says so and shows the agent\'s rows from the log', async () => {
    seed(makeSession('L', {
      subagents: [makeRun()],
      toolLog: [
        { tool: 'Grep', input: 'roomSync in src', timestamp: T0 + 15, agentId: 'a1' },
        { tool: 'Edit', input: 'leader-only.ts', timestamp: T0 + 16 },
      ],
    }));
    serve(() => null);
    render(<AgentsTab sessionId="L" />);
    await openCard(/aasc20-rooms, subagent/i);
    expect(await screen.findByText(/no transcript for this agent/i)).toBeTruthy();
    const log = screen.getByRole('table', { name: /agent activity/i });
    expect(within(log).getByText('roomSync in src')).toBeTruthy();
    expect(within(log).queryByText('leader-only.ts')).toBeNull();
    // The task still comes from the run's description.
    expect(within(screen.getByRole('region', { name: 'Task' })).getByText('AASC-20 rooms sync for phones')).toBeTruthy();
  });

  it('a failed load says so and can be retried', async () => {
    let fail = true;
    serve(() => (fail ? new Response(JSON.stringify({ success: false, error: 'Subagent not found' }), { status: 404 }) : page()));
    render(<AgentsTab sessionId="L" />);
    const user = await openCard(/aasc20-rooms, subagent/i);
    expect(await screen.findByText(/Subagent not found/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('I will start by reading the rooms code.')).toBeTruthy();
  });

  it('closes when another session is shown', async () => {
    seed(makeSession('L', { subagents: [makeRun()] }), makeSession('M', { subagents: [makeRun({ agentId: 'b1', agentType: 'Plan' })] }));
    const { rerender } = render(<AgentsTab sessionId="L" />);
    await openCard(/aasc20-rooms, subagent/i);
    rerender(<AgentsTab sessionId="M" />);
    expect(screen.getByRole('region', { name: /agent diagram/i })).toBeTruthy();
  });
});

describe('AGENTS tab — open a teammate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a teammate card switches to that teammate\'s own session', async () => {
    seed(
      makeSession('L', { teamId: 'team-L', teamRole: 'leader' }),
      makeSession('T', { teamId: 'team-L', teamRole: 'member', agentName: 'reviewer', startedAt: T0 + 1 }),
    );
    render(<AgentsTab sessionId="L" />);
    await openCard(/reviewer, teammate/i);
    expect(useSessionStore.getState().selectedSessionId).toBe('T');
  });
});
