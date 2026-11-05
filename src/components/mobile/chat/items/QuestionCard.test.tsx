// QuestionCard.test.tsx — an agent's question as a card in the phone chat (Nov 2 2026): Claude's open
// AskUserQuestion answered through the Mac's checked route (and the waiting card stops repeating its
// choices), Codex's question answered by sending the pick as the next message, and closed questions
// with their pick marked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DevicePresence, PendingRequest, Session } from '@/types';
import type { ChatEntry } from '@/types/chat';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/chat/promptApi', () => ({
  sendPrompt: vi.fn(async () => ({ ok: true, key: 'k1' })),
  waitForPrompt: vi.fn(() => new Promise(() => {})),
  promptOutcome: vi.fn(() => ({ ok: true })),
}));

import QuestionCard from './QuestionCard';
import WaitingCard from '../WaitingCard';
import { ChatTerminalContext } from '../chatQuestions';
import { buildChatItems, type QuestionItem } from '@/lib/chat/buildChatItems';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';
import { sendPrompt } from '@/lib/chat/promptApi';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const stream = (...drafts: Array<Record<string, unknown>>): ChatEntry[] =>
  drafts.map((d, i) => ({ key: `${i * 100}:0`, timestamp: T0 + i * 1000, ...d }) as ChatEntry);

const ask = {
  questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Cards', description: 'One per project' }, { label: 'List' }] }],
};
const request: PendingRequest = {
  id: 'toolu_q', toolUseId: 'toolu_q', kind: 'question', cli: 'claude', tool: 'AskUserQuestion', raisedAt: 1, source: 'pre_tool_use',
  input: ask, options: [{ label: 'Cards', description: 'One per project' }, { label: 'List' }],
};

function questionOf(entries: ChatEntry[], live = false): QuestionItem {
  return buildChatItems(entries, live ? { live: true, awaiting: true } : {}).find((i): i is QuestionItem => i.kind === 'question')!;
}

function device(clientId: string, isLocal: boolean): DevicePresence {
  return { clientId, label: clientId === 'desk' ? 'MacBook' : 'iPhone', address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

function setSession(patch: Partial<Session>) {
  const s = { sessionId: 's1', status: 'input', cliSource: 'claude', projectName: 'agent-manager', projectPath: '/p', terminalId: 'term-1', pendingRequest: null, ...patch } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([['s1', s]]) });
  return s;
}

function stubAnswer() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return { ok: true, status: 202, json: async () => ({ success: true, data: { accepted: true } }) };
  }));
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({ devices: [device('phone', false), device('desk', true)], controllers: [], restoreOwner: 'desk', workspaceWriter: 'desk' });
  useQueueStore.setState({ queues: new Map() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QuestionCard — Claude', () => {
  const entries = stream({ kind: 'user', text: 'build it' }, { kind: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: ask });

  it('answers the open request from the chat, and the waiting card stops repeating the choices', async () => {
    const calls = stubAnswer();
    const s = setSession({ pendingRequest: request });
    render(
      <>
        <QuestionCard item={questionOf(entries, true)} sessionId="s1" />
        <WaitingCard session={s} card={waitingCardModel(s)!} onTerminal={vi.fn()} onTell={vi.fn()} />
      </>,
    );
    expect(within(screen.getByTestId('chat-question')).getByRole('heading', { name: 'Claude asks' })).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-question')).getByText('Layout')).toBeInTheDocument();
    // One set of buttons: the chat's. The waiting card keeps Other… and the terminal.
    expect(screen.getAllByRole('button', { name: /^List/ })).toHaveLength(1);
    expect(screen.getByTestId('waiting-card-in-chat')).toHaveTextContent('Answer above');
    expect(screen.getByRole('button', { name: /Other…/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^List/ }));
    await waitFor(() => expect(calls[0]?.body).toEqual({ choice: 'option', optionIndex: 1 }));
    expect(calls[0]?.url).toContain('/api/sessions/s1/requests/toolu_q/answer');
    expect(await screen.findByText('Answered. Waiting for Claude to go on…')).toBeInTheDocument();
  });

  // Nov 5 2026: the pinned card repeated the whole question under the chat's own copy, grew to a
  // third of the screen and covered the chat's answer buttons.
  it('shrinks the waiting card while the chat shows the question: no second copy of what is asked', () => {
    stubAnswer();
    const s = setSession({ pendingRequest: request });
    render(
      <>
        <QuestionCard item={questionOf(entries, true)} sessionId="s1" />
        <WaitingCard session={s} card={waitingCardModel(s)!} onTerminal={vi.fn()} onTell={vi.fn()} />
      </>,
    );
    const pinned = screen.getByTestId('waiting-card');
    expect(within(pinned).queryByText('Which layout?')).toBeNull();
    expect(within(pinned).queryByText('Layout')).toBeNull();
    expect(within(pinned).queryByText(/in agent-manager/)).toBeNull();
    expect(within(screen.getByTestId('chat-question')).getByText('Which layout?')).toBeInTheDocument();
    // Still there: the title, the pointer to the chat, Other… and the terminal.
    expect(within(pinned).getByRole('heading', { name: 'Claude asks' })).toBeInTheDocument();
    expect(within(pinned).getByRole('button', { name: /Other…/ })).toBeInTheDocument();
    expect(within(pinned).getByTestId('waiting-card-terminal')).toBeInTheDocument();
  });

  it('"Answer above" scrolls the chat to the question', () => {
    stubAnswer();
    const s = setSession({ pendingRequest: request });
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    try {
      render(
        <>
          <QuestionCard item={questionOf(entries, true)} sessionId="s1" />
          <WaitingCard session={s} card={waitingCardModel(s)!} onTerminal={vi.fn()} onTell={vi.fn()} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Answer above' }));
      expect(scrolled).toEqual([screen.getByTestId('chat-question')]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('leaves the waiting card its buttons when no chat card answers', () => {
    stubAnswer();
    const s = setSession({ pendingRequest: request });
    render(<WaitingCard session={s} card={waitingCardModel(s)!} onTerminal={vi.fn()} onTell={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^List/ })).toBeInTheDocument();
    expect(screen.queryByTestId('waiting-card-in-chat')).toBeNull();
  });

  it('sends a question only the terminal can answer there', () => {
    setSession({ pendingRequest: { ...request, options: undefined } });
    const onTerminal = vi.fn();
    render(
      <ChatTerminalContext.Provider value={onTerminal}>
        <QuestionCard item={questionOf(entries, true)} sessionId="s1" />
      </ChatTerminalContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /^List/ })).toBeNull();
    fireEvent.click(screen.getByTestId('chat-question-terminal'));
    expect(onTerminal).toHaveBeenCalled();
  });

  it('marks the pick of an answered question', () => {
    setSession({ status: 'working' });
    const item = questionOf(stream(
      { kind: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: ask },
      { kind: 'tool_result', toolUseId: 'toolu_q', isError: false, output: 'User has answered your questions: "Which layout?"="Cards". You can now continue', truncated: false },
    ));
    render(<QuestionCard item={item} sessionId="s1" />);
    expect(screen.getByRole('heading', { name: 'Claude asked' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('(chosen)').closest('li')).toHaveTextContent('Cards');
  });
});

describe('QuestionCard — Codex', () => {
  const codexAsk = { questions: [{ title: 'Deploy which?', options: ['Current (recommended)', 'Local'] }] };
  const asked = stream(
    { kind: 'user', text: 'deploy' },
    { kind: 'tool_use', id: 'call_1', name: 'request_user_input_async', input: codexAsk },
    { kind: 'tool_result', toolUseId: 'call_1', isError: false, output: '{"accepted":true}', truncated: false },
  );

  it('sends the pick as the next message while Codex waits', async () => {
    setSession({ status: 'waiting', cliSource: 'codex' });
    render(<QuestionCard item={questionOf(asked)} sessionId="s1" />);
    expect(screen.getByRole('heading', { name: 'Codex asks' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'Local', mode: 'now' })));
  });

  it('queues the pick while Codex is still working', () => {
    setSession({ status: 'working', cliSource: 'codex' });
    render(<QuestionCard item={questionOf(asked)} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useQueueStore.getState().queues.get('s1')?.map((q) => q.text)).toEqual(['Local']);
  });

  it('collects one pick per question, then sends them together', async () => {
    setSession({ status: 'waiting', cliSource: 'codex' });
    const two = stream(
      { kind: 'tool_use', id: 'call_2', name: 'request_user_input', input: { questions: [{ title: 'Owner?', options: ['Me', 'Team'] }, { title: 'Region?', options: ['NZ', 'AU'] }] } },
      { kind: 'tool_result', toolUseId: 'call_2', isError: false, output: '{"accepted":true}', truncated: false },
    );
    render(<QuestionCard item={questionOf(two)} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(sendPrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'NZ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'Owner?: Team\nRegion?: NZ' })));
  });

  it('never types into an open dialog', () => {
    setSession({ status: 'approval', cliSource: 'codex', pendingRequest: { ...request, kind: 'permission', cli: 'codex', tool: 'shell' } });
    render(<QuestionCard item={questionOf(asked)} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Local' }));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.getByText('Answer the card below first')).toBeInTheDocument();
  });

  it('closes once you reply, marking an exact pick', () => {
    setSession({ status: 'working', cliSource: 'codex' });
    const replied = [...asked, { key: '900:0', timestamp: T0 + 9000, kind: 'user', text: 'Local' } as ChatEntry];
    render(<QuestionCard item={questionOf(replied)} sessionId="s1" />);
    expect(screen.getByRole('heading', { name: 'Codex asked' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('(chosen)').closest('li')).toHaveTextContent('Local');
  });
});
