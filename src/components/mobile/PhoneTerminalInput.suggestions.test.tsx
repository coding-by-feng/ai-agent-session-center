// PhoneTerminalInput.suggestions.test.tsx — the suggestion bar in the terminal's
// compose box on a phone (AASC-20, feature 70): there for an agent session while
// the box has the keyboard, never for an ops shell (no slash commands there) and
// never while another device drives.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';

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
import { resetPhoneSkillNotesCache } from '@/lib/phoneSuggestions';

function holder(clientId: 'none' | 'desk') {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({
    devices: ['phone', 'desk'].map((id) => ({
      clientId: id, label: id === 'desk' ? 'MacBook' : 'iPhone', address: '192.168.4.20', isLocal: false, connections: 1, connectedAt: 1, lastSeenAt: 1,
    })),
    controllers: clientId === 'desk'
      ? [{ sessionId: 's1', clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now(), online: true }]
      : [],
    restoreOwner: null,
    workspaceWriter: null,
  });
}

function Harness({ sessionId }: { sessionId: string | null }) {
  const [draft, setDraft] = useState('');
  return (
    <PhoneTerminalInput
      terminalId="term-1"
      sessionId={sessionId}
      draft={draft}
      onDraftChange={setDraft}
      onKey={vi.fn()}
      socketNotice={null}
      onDismissSocketNotice={vi.fn()}
      onOpenActions={vi.fn()}
    />
  );
}

const focusCompose = () => act(() => screen.getByRole('textbox', { name: 'Message to send to the terminal' }).focus());

beforeEach(() => {
  resetPhoneSkillNotesCache();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ source: 'none', entries: [] }))));
  holder('none');
});
afterEach(() => vi.unstubAllGlobals());

describe('PhoneTerminalInput — suggestions above the keyboard', () => {
  it('shows the bar for an agent session once the box has the keyboard', async () => {
    render(<Harness sessionId="s1" />);
    expect(screen.queryByRole('toolbar', { name: 'Suggestions' })).toBeNull();
    focusCompose();
    expect(await screen.findByRole('toolbar', { name: 'Suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Type a command' })).toBeInTheDocument();
  });

  it('has no bar for an ops shell, which has no slash commands', () => {
    render(<Harness sessionId={null} />);
    focusCompose();
    expect(screen.queryByRole('toolbar', { name: 'Suggestions' })).toBeNull();
  });

  // Oct 2026, by request: no control baton for people. Another device having typed last changes nothing here.
  it('keeps typing on while another device typed into the session last', () => {
    holder('desk');
    render(<Harness sessionId="s1" />);
    expect(screen.getByRole('textbox', { name: 'Message to send to the terminal' })).not.toBeDisabled();
  });
});
