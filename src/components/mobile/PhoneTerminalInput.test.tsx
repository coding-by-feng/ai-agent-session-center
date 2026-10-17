// PhoneTerminalInput.test.tsx — how a phone types into a terminal (AASC-18):
// the compose box, the key bar and the control banner.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { DevicePresence } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PhoneTerminalInput from './PhoneTerminalInput';
import { usePresenceStore } from '@/stores/presenceStore';
import { claimControl, requestControl } from '@/lib/presenceClient';

const SID = 's1';

function device(clientId: string, label: string): DevicePresence {
  return { clientId, label, address: '192.168.4.20', isLocal: false, connections: 1, connectedAt: 1, lastSeenAt: 1 };
}

/** Who holds s1: nobody, or the MacBook (idle for `idleMs`). */
function presence(holder: 'none' | 'desk', idleMs = 0) {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: [device('phone', 'iPhone'), device('desk', 'MacBook')],
    controllers: holder === 'desk'
      ? [{ sessionId: SID, clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now() - idleMs, online: true }]
      : [],
    restoreOwner: null,
    workspaceWriter: null,
  });
}

/** The writes the compose box made, as their `data`. */
function stubWrites(status = 200, body: unknown = { ok: true }) {
  type FakeFetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  const fetchMock = vi.fn<FakeFetch>(async () => ({ ok: status === 200, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).data as string);
}

function Harness(props: { onKey?: (d: string) => void; socketNotice?: string | null; sessionId?: string | null }) {
  const [draft, setDraft] = useState('');
  return (
    <PhoneTerminalInput
      terminalId="term-1"
      sessionId={props.sessionId === undefined ? SID : props.sessionId}
      draft={draft}
      onDraftChange={setDraft}
      onKey={props.onKey ?? vi.fn()}
      socketNotice={props.socketNotice ?? null}
      onDismissSocketNotice={vi.fn()}
      onOpenActions={vi.fn()}
    />
  );
}

const compose = () => screen.getByRole('textbox', { name: 'Message to send to the terminal' });

beforeEach(() => {
  vi.mocked(claimControl).mockClear();
  vi.mocked(requestControl).mockClear();
  presence('none');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('compose box', () => {
  it('sends the text, then Enter on its own, exactly once, and clears', async () => {
    vi.useFakeTimers();
    const writes = stubWrites();
    render(<Harness />);
    fireEvent.change(compose(), { target: { value: 'run the tests again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(writes()).toEqual(['run the tests again']);
    expect(compose()).toHaveValue('');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(writes()).toEqual(['run the tests again', '\r']);
    // A second tap on an empty box sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(writes()).toHaveLength(2);
  });

  it('keeps words typed while the send is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    render(<Harness />);
    fireEvent.change(compose(), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(compose(), { target: { value: 'first, and then more' } });
    await act(async () => { release(); await gate; });
    expect(compose()).toHaveValue('first, and then more');
  });

  it('Return sends; Return while an IME composes does not', async () => {
    const writes = stubWrites();
    render(<Harness />);
    fireEvent.change(compose(), { target: { value: '你好' } });
    fireEvent.keyDown(compose(), { key: 'Enter', keyCode: 229, isComposing: true });
    expect(writes()).toEqual([]);
    fireEvent.keyDown(compose(), { key: 'Enter' });
    await waitFor(() => expect(writes()).toEqual(['你好']));
  });

  it('keeps the text and shows the server\'s words when the agent is not running', async () => {
    stubWrites(409, { error: 'A phone can type only while the agent is running', code: 'AGENT_NOT_RUNNING' });
    render(<Harness />);
    fireEvent.change(compose(), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A phone can type only while the agent is running');
    expect(compose()).toHaveValue('hello');
  });

  it('shows a terminal_error from the socket near the compose box', () => {
    render(<Harness socketNotice="A phone can type only while the agent is running" />);
    expect(screen.getByRole('alert')).toHaveTextContent('A phone can type only while the agent is running');
  });
});

describe('key bar', () => {
  it('sends each key\'s sequence', () => {
    const onKey = vi.fn();
    render(<Harness onKey={onKey} />);
    const keys: Array<[string, string]> = [
      ['Escape', '\x1b'], ['Tab', '\t'], ['Up arrow', '\x1b[A'], ['Down arrow', '\x1b[B'],
      ['Choose 1', '1'], ['Choose 2', '2'], ['Choose 3', '3'], ['Enter', '\r'],
    ];
    for (const [name] of keys) fireEvent.click(screen.getByRole('button', { name }));
    expect(onKey.mock.calls.map(([d]) => d)).toEqual(keys.map(([, d]) => d));
  });
});

describe('control baton', () => {
  // Oct 2026, by request: no Ask / Take control. The phone types even while another device typed last.
  it('types freely, with no banner, while another device typed into the session last', () => {
    presence('desk', 5_000);
    const onKey = vi.fn();
    render(<Harness onKey={onKey} />);
    expect(screen.queryByText('MacBook is driving this session')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask for control' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Take/ })).toBeNull();
    expect(compose()).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose 1' }));
    expect(onKey).toHaveBeenCalled();
  });

  it('shows no banner and types freely when nobody holds the session', () => {
    render(<Harness />);
    expect(screen.queryByRole('region', { name: 'Session control' })).toBeNull();
    expect(compose()).not.toBeDisabled();
  });

  it('a terminal with no session (an ops shell) has no baton', () => {
    presence('desk', 5_000);
    render(<Harness sessionId={null} />);
    expect(compose()).not.toBeDisabled();
    expect(compose()).toHaveAttribute('placeholder', 'Type a command');
  });
});
