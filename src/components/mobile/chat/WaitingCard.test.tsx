// WaitingCard.test.tsx — the approval / question card above the composer (AASC-43):
// what is asked, the CLI's own choices through the checked route, "Already answered
// on your Mac", "Open terminal" as the only way out when the Mac can't tell the
// choices, the "Always allow" gate, and taking control before answering.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DevicePresence, PendingRequest, Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import WaitingCard from './WaitingCard';
import { usePresenceStore } from '@/stores/presenceStore';
import { claimControl } from '@/lib/presenceClient';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

function stubAnswer(status = 202, body: unknown = { success: true, data: { accepted: true } }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }));
  return calls;
}

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function presence(held = false) {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', false), device('desk', true)],
    controllers: held ? [{ sessionId: 's1', clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now() - 120_000, online: true }] : [],
    restoreOwner: 'desk',
    workspaceWriter: 'desk',
  });
}

const bash: PendingRequest = { id: 'toolu_1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request', input: { command: 'npm run build' }, canAlwaysAllow: true };

function session(request: PendingRequest | null, status = 'approval'): Session {
  return { sessionId: 's1', status, cliSource: 'claude', projectName: 'agent-manager', projectPath: '/p', terminalId: 'term-1', pendingRequest: request, pendingTool: 'Bash', pendingToolDetail: 'npm run build', waitingDetail: null } as unknown as Session;
}

function renderCard(s: Session, handlers: { onTerminal?: () => void; onTell?: () => void } = {}) {
  const card = waitingCardModel(s)!;
  return render(<WaitingCard session={s} card={card} onTerminal={handlers.onTerminal ?? vi.fn()} onTell={handlers.onTell ?? vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  presence();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WaitingCard', () => {
  it('shows the exact command and Claude’s choices', () => {
    stubAnswer();
    renderCard(session(bash));
    expect(screen.getByRole('heading', { name: 'Claude wants to run a command' })).toBeInTheDocument();
    expect(screen.getByLabelText('Command')).toHaveTextContent('npm run build');
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(['Deny', 'Always allow', 'Allow once', 'Tell Claude what to do instead…', 'Open terminal']),
    );
  });

  it('answers Allow once through the Mac’s checked route', async () => {
    const calls = stubAnswer();
    renderCard(session(bash));
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await screen.findByText(/Answered/);
    expect(calls).toEqual([{ url: '/api/sessions/s1/requests/toolu_1/answer', body: { choice: 'allow_once' } }]);
  });

  it('says "Already answered on your Mac" for a stale card, and types nothing', async () => {
    stubAnswer(409, { code: 'stale' });
    renderCard(session(bash));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Already answered on your Mac')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });

  it('leaves only "Open terminal" when the Mac can’t tell the choices', async () => {
    stubAnswer(422, { code: 'unknown_prompt' });
    const onTerminal = vi.fn();
    renderCard(session(bash), { onTerminal });
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText(/Answer it in the terminal/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('waiting-card-terminal'));
    expect(onTerminal).toHaveBeenCalled();
  });

  it('offers only "Open terminal" for a guess from the timer', () => {
    stubAnswer();
    renderCard(session({ ...bash, source: 'timer', input: undefined }));
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    expect(screen.getByTestId('waiting-card-terminal')).toBeInTheDocument();
  });

  it('for an input cut to fit, offers Deny and says once why it can’t be allowed here', () => {
    stubAnswer();
    renderCard(session({ ...bash, input: { command: 'echo … [truncated]' }, inputTruncated: true }));
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getAllByText('Too long to show in full: allow it in the terminal.')).toHaveLength(1);
    expect(screen.getByTestId('waiting-card-terminal')).toBeInTheDocument();
  });

  it('asks before "Always allow" (no Face ID bridge on a Mac-served page)', async () => {
    const calls = stubAnswer();
    renderCard(session(bash));
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(await screen.findByRole('dialog', { name: 'Always allow?' })).toBeInTheDocument();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Always allow' }).at(-1)!);
    await waitFor(() => expect(calls[0]?.body).toEqual({ choice: 'allow_always' }));
  });

  it('while another device drives, the button reads "Take control and allow once", and takes control first', async () => {
    const calls = stubAnswer();
    presence(true);
    renderCard(session(bash));
    fireEvent.click(screen.getByRole('button', { name: 'Take control and allow once' }));
    expect(await screen.findByRole('dialog', { name: 'Take control and allow once?' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Take control and allow once' }).at(-1)!);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(claimControl).toHaveBeenCalledWith('s1', true);
  });

  it('while another device drives, offers no "Tell Claude…" (the box is off), but always "Open terminal"', () => {
    stubAnswer();
    presence(true);
    renderCard(session(bash));
    expect(screen.queryByRole('button', { name: /Tell Claude what to do instead/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('waiting-card-terminal')).toBeInTheDocument();
    expect(screen.getByText('Your Mac is driving. Answering takes control.')).toBeInTheDocument();
  });

  it('a question shows its options, then Other…, which hands over to the composer', async () => {
    const calls = stubAnswer();
    const onTell = vi.fn();
    const ask: PendingRequest = {
      id: 'q1', kind: 'question', cli: 'claude', tool: 'AskUserQuestion', raisedAt: 1, source: 'pre_tool_use',
      input: { questions: [{ question: 'Which phase?', options: [] }] }, options: [{ label: 'Deposit' }, { label: 'Final' }],
    };
    renderCard(session(ask, 'input'), { onTell });
    expect(screen.getByText('Which phase?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Final' }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ choice: 'option', optionIndex: 1 }));
  });

  it('Other… and "Tell Claude…" focus the composer', () => {
    stubAnswer();
    const onTell = vi.fn();
    renderCard(session(bash), { onTell });
    fireEvent.click(screen.getByRole('button', { name: /Tell Claude what to do instead/ }));
    expect(onTell).toHaveBeenCalled();
  });
});
