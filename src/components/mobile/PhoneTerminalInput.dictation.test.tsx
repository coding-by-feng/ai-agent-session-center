// PhoneTerminalInput.dictation.test.tsx — the hold-to-talk mic beside the terminal's compose box
// (Nov 16 2026): the app only; the words fill the box and nothing is written to the terminal.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { DICTATION_EVENT, DICTATION_HANDLER } from '@/lib/phoneDictation';

function installApp() {
  const posted: Array<{ id: string; action: string }> = [];
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { [DICTATION_HANDLER]: { postMessage: (m: { id: string; action: string }) => posted.push(m) } } };
  const answer = (detail: Record<string, unknown>) => act(() => { window.dispatchEvent(new CustomEvent(DICTATION_EVENT, { detail })); });
  return { posted, answer };
}

function stubMac(status = 200, json: unknown = { success: true, data: { text: 'list the files' } }) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    return { ok: status === 200, status, json: async () => json };
  }));
  return urls;
}

function Harness({ closed = false }: { closed?: boolean }) {
  const [draft, setDraft] = useState('');
  return (
    <PhoneTerminalInput
      terminalId="term-1"
      sessionId="s1"
      draft={draft}
      onDraftChange={setDraft}
      onKey={vi.fn()}
      socketNotice={null}
      onDismissSocketNotice={vi.fn()}
      onOpenActions={vi.fn()}
      closed={closed}
    />
  );
}

const box = () => screen.getByLabelText('Message to send to the terminal') as HTMLTextAreaElement;
const mic = () => screen.getByTestId('dictate-button');

beforeEach(() => {
  usePresenceStore.setState({ pendingRequests: new Map() });
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
});

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
  vi.unstubAllGlobals();
});

describe('the terminal compose box’s hold-to-talk mic', () => {
  it('is not there without the app’s recorder', () => {
    stubMac();
    render(<Harness />);
    expect(screen.queryByTestId('dictate-button')).toBeNull();
  });

  it('fills the box with the spoken words and writes nothing to the terminal', async () => {
    const urls = stubMac();
    const app = installApp();
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'cd src &&' } });
    fireEvent.pointerDown(mic());
    expect(screen.getByTestId('dictation-line')).toHaveTextContent(/Listening/);
    fireEvent.pointerUp(mic());
    app.answer({ id: app.posted[0].id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
    await waitFor(() => expect(box().value).toBe('cd src && list the files'));
    expect(urls).toEqual(['/api/voice/dictate']);
    expect(screen.queryByTestId('dictation-line')).toBeNull();
  });

  it('an error shows in the notice, which dismisses', async () => {
    stubMac(502, { success: false, code: 'network', error: 'The Mac could not reach OpenAI.' });
    const app = installApp();
    render(<Harness />);
    fireEvent.pointerDown(mic());
    fireEvent.pointerUp(mic());
    app.answer({ id: app.posted[0].id, state: 'audio', audio: 'QUJD', mime: 'audio/mp4', ms: 1500 });
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('The Mac could not reach OpenAI.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is off for a closed terminal', () => {
    stubMac();
    installApp();
    render(<Harness closed />);
    expect(mic()).toBeDisabled();
  });
});
