// InboxScreen.test.tsx — the Inbox tab (AASC-43): every kind of item, the filters,
// answering in place, Continue, opening the session, and this phone's read marks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PendingRequest, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import InboxScreen from './InboxScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { DEFAULT_RESUME_PROMPT } from '@/lib/resumeWatchdog';

const NOW = Date.now();

function session(id: string, title: string, status: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: id, title, status, projectName: 'proj', lastActivityAt: NOW - 60_000, responseLog: [], terminalId: `term-${id}`,
    cliSource: 'claude', pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null, ...extra,
  } as unknown as Session;
}

const bash: PendingRequest = { id: 'toolu_1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: NOW - 120_000, source: 'permission_request', input: { command: 'npm run build' } };
const ask: PendingRequest = {
  id: 'q1', kind: 'question', cli: 'claude', tool: 'AskUserQuestion', raisedAt: NOW - 90_000, source: 'pre_tool_use',
  input: { questions: [{ question: 'Which payment phase applies?', options: [] }] }, options: [{ label: 'Deposit' }, { label: 'Final' }],
};

function load() {
  useSessionStore.setState({
    sessions: new Map([
      ['a', session('a', 'agent-manager-2', 'approval', { pendingRequest: bash })],
      ['b', session('b', 'exmouth-erp-1', 'input', { pendingRequest: ask })],
      ['c', session('c', 'aasc-backend-1', 'waiting', { interruption: { kind: 'api_error', line: 'API Error: 529', detectedAt: NOW - 30_000 } as Session['interruption'] })],
      ['d', session('d', 'website-1', 'waiting', { responseLog: [{ text: 'Updated the pricing page and checked the build.', timestamp: NOW - 720_000 }] })],
    ]),
  });
  useWsStore.setState({ snapshotReceived: true });
}

function stubMac() {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (/\/prompt$/.test(url)) return { ok: true, status: 202, json: async () => ({ success: true, data: { accepted: true, key: body?.key } }) };
    if (/\/prompt\//.test(url)) return { ok: true, status: 200, json: async () => ({ success: true, data: { state: 'submitted' } }) };
    return { ok: true, status: 202, json: async () => ({ success: true, data: { accepted: true } }) };
  }));
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  load();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InboxScreen', () => {
  it('lists what waits first: approvals, questions and stopped turns', () => {
    stubMac();
    render(<InboxScreen />);
    const items = screen.getAllByTestId('inbox-item');
    expect(items.map((i) => within(i).getByText(/agent-manager-2|exmouth-erp-1|aasc-backend-1/).textContent)).toEqual(['agent-manager-2', 'exmouth-erp-1', 'aasc-backend-1']);
    expect(screen.getByText('Wants to run: npm run build')).toBeInTheDocument();
    expect(screen.getByText('Which payment phase applies?')).toBeInTheDocument();
    expect(screen.getByText('Stopped: API Error: 529')).toBeInTheDocument();
    expect(screen.queryByText(/pricing page/)).not.toBeInTheDocument();
  });

  it('shows finished turns under Finished, and everything under All', () => {
    stubMac();
    render(<InboxScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Finished 1' }));
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(1);
    expect(screen.getByText('Updated the pricing page and checked the build.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(4);
  });

  it('answers an approval in place, without "Always allow" (that one is decided in the session)', async () => {
    const calls = stubMac();
    render(<InboxScreen />);
    const item = screen.getAllByTestId('inbox-item')[0];
    expect(within(item).queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(calls[0]).toEqual({ url: '/api/sessions/a/requests/toolu_1/answer', body: { choice: 'allow_once' } }));
  });

  it('picks a question’s option in place', async () => {
    const calls = stubMac();
    render(<InboxScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ choice: 'option', optionIndex: 0 }));
  });

  it('continues a stopped turn through the Mac’s confirmed send', async () => {
    const calls = stubMac();
    render(<InboxScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/sessions/c/prompt')?.body).toMatchObject({ text: DEFAULT_RESUME_PROMPT, mode: 'now' }));
  });

  it('opens the session’s chat on this tab’s stack', () => {
    stubMac();
    const pushSpy = vi.spyOn(usePhoneNavStore.getState(), 'push');
    usePhoneNavStore.setState({ push: pushSpy });
    render(<InboxScreen />);
    fireEvent.click(screen.getByRole('button', { name: /agent-manager-2: .*Open the session/ }));
    expect(pushSpy).toHaveBeenCalledWith('/sessions/a/chat');
  });

  it('marks everything read on this phone', () => {
    stubMac();
    render(<InboxScreen />);
    expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(screen.queryAllByRole('img', { name: 'Unread' })).toHaveLength(0);
    expect(Object.keys(JSON.parse(localStorage.getItem('aasc.inboxRead') ?? '{}'))).toHaveLength(4);
  });

  it('says plainly when nothing waits', () => {
    stubMac();
    useSessionStore.setState({ sessions: new Map([['d', session('d', 'website-1', 'waiting', { responseLog: [{ text: 'Done', timestamp: NOW - 10_000 }] })]]) });
    render(<InboxScreen />);
    expect(screen.getByText('Nothing needs you')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See 1 finished' }));
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});
