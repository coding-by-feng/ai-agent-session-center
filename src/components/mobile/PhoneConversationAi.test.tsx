// PhoneConversationAi.test.tsx — the AI popup from the Conversation text on a phone (AASC-20): select
// text, Ask AI, pick an action; the fork starts and opens straight into the phone's sheet.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/lib/translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1') }));

import { createLog } from '@/lib/translationLog';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { SELECTABLE_ATTR } from '@/hooks/useSelectionIn';
import PhoneConversationAi from './PhoneConversationAi';

const session = (over: Partial<Session> = {}): Session => ({
  sessionId: 's1', title: 'AASC', projectName: 'agent-manager', projectPath: '/w/a', status: 'idle',
  cliSource: 'claude', events: [], promptHistory: [], ...over,
}) as unknown as Session;

let fetchMock: ReturnType<typeof vi.fn>;

function view(scope = 's1') {
  return render(
    <>
      <div {...{ [SELECTABLE_ATTR]: scope }}>
        <div data-ai-context="">The router mounts its visibility gate on /sessions/:id.</div>
      </div>
      <p data-testid="elsewhere">Some other text on the page</p>
      <PhoneConversationAi sessionId="s1" />
    </>,
  );
}

function select(el: Element, from: number, to: number) {
  act(() => {
    const range = document.createRange();
    range.setStart(el.firstChild!, from);
    range.setEnd(el.firstChild!, to);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: new Map([['s1', session()]]) });
  useSettingsStore.setState({
    translationEnabled: true, translationTrigger: 'auto', translationNativeLanguage: '简体中文',
    translationLearningLanguage: 'English', translationInheritContext: true,
    selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
  });
  useFloatingSessionsStore.setState({ floats: [], phoneShown: null });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, terminalId: 'term-f1', label: 'Explain (English)' })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe('PhoneConversationAi', () => {
  it('offers Ask AI while text in this conversation is selected, and not for text elsewhere', () => {
    view();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    select(screen.getByTestId('elsewhere'), 0, 10);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    select(screen.getByText(/visibility gate/), 4, 32);
    expect(screen.getByRole('region', { name: 'Selected text' }).textContent).toContain('router mounts its visibilit');
  });

  it('is off where the desktop popup is off: the session’s toggle, or translation disabled', () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({ aiPopupEnabled: false })]]) });
    const { unmount } = view();
    select(screen.getByText(/visibility gate/), 4, 32);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    unmount();
    useSessionStore.setState({ sessions: new Map([['s1', session()]]) });
    useSettingsStore.setState({ translationEnabled: false });
    view();
    select(screen.getByText(/visibility gate/), 4, 32);
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  it('keeps the selection it caught when the tap begins, even if the tap clears it', () => {
    view();
    select(screen.getByText(/visibility gate/), 4, 32);
    const ask = screen.getByRole('button', { name: 'Ask AI' });
    fireEvent.pointerDown(ask);
    act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(screen.getByRole('dialog', { name: 'Ask AI about the selection' })).toBeTruthy();
    expect(screen.getByLabelText('Selected text', { selector: 'blockquote' }).textContent).toBe('router mounts its visibility');
  });

  it('starts the fork from the session (not a terminal), logs it and shows it in the phone sheet', async () => {
    view();
    select(screen.getByText(/visibility gate/), 4, 32);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'In English' }));
    await waitFor(() => expect(useFloatingSessionsStore.getState().phoneShown).toBe('term-f1'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sessions/spawn-floating');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      originSessionId: 's1', mode: 'explain-learning', selection: 'router mounts its visibility',
      nativeLanguage: '简体中文', learningLanguage: 'English', inheritContext: true,
    });
    expect(body.contextLine).toContain('/sessions/:id');
    expect(body.spawnTerminalId).toBeUndefined();
    expect(useFloatingSessionsStore.getState().floats).toEqual([
      expect.objectContaining({ terminalId: 'term-f1', label: 'Explain (English)', originSessionId: 's1' }),
    ]);
    expect(createLog).toHaveBeenCalledWith(expect.objectContaining({ mode: 'explain-learning', floatTerminalId: 'term-f1' }));
    expect(screen.queryByRole('dialog', { name: 'Ask AI about the selection' })).toBeNull();
  });

  it('sends your own prompt with the selection', async () => {
    view();
    select(screen.getByText(/visibility gate/), 4, 32);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /your own prompt/i }), { target: { value: 'Is this safe?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ mode: 'custom', customPrompt: 'Is this safe?' });
  });

  it('shows the server’s refusal and opens nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 }));
    view();
    select(screen.getByText(/visibility gate/), 4, 32);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'To English' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Session not found');
    expect(useFloatingSessionsStore.getState().floats).toEqual([]);
    expect(useFloatingSessionsStore.getState().phoneShown).toBeNull();
  });
});
