// RecentPromptsSheet.summary.test.tsx — the desktop peek's Summary in the phone sheet (Nov 27 2026): the
// answer the Mac keeps on the session, its age, stale and error lines, and one button named for what it does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import RecentPromptsSheet from './RecentPromptsSheet';
import { useSessionStore } from '@/stores/sessionStore';

const NOW = Date.now();
const base = {
  sessionId: 's1', cliSource: 'claude', title: 'AASC', projectName: 'agent-manager', status: 'waiting',
  lastActivityAt: NOW, toolLog: [], responseLog: [],
  promptHistory: [{ text: 'fix the queue badge', timestamp: NOW - 120_000 }],
} as unknown as Session;

const put = (over: Partial<Session> = {}) =>
  useSessionStore.setState({ sessions: new Map([['s1', { ...base, ...over } as Session]]) });
const open = () => render(<RecentPromptsSheet sessionId="s1" onClose={vi.fn()} onOpenPrompt={vi.fn()} onAllPrompts={vi.fn()} />);
const sheet = () => screen.getByTestId('recent-prompts-sheet');

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"ok":true,"state":"running"}', { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('the Summary in Recent prompts', () => {
  it('offers a summary, asks the Mac once, and shows it when it arrives', async () => {
    put();
    open();
    expect(within(sheet()).queryByRole('region', { name: 'Summary' })).toBeNull();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Summarize what this session has done' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/recap', { method: 'POST' }));
    // The Mac marks the run on the session; the update reaches the sheet as it would over the socket.
    act(() => put({ recap: { state: 'running', at: Date.now(), promptAt: NOW - 120_000 } }));
    expect(within(sheet()).getByRole('button', { name: 'Summarizing this session' })).toHaveAttribute('aria-busy', 'true');
    act(() => put({ recap: { state: 'done', text: '• Fixed the badge.', at: Date.now(), promptAt: NOW - 120_000 } }));
    const block = within(sheet()).getByRole('region', { name: 'Summary' });
    expect(block.textContent).toMatch(/Summary · just now/);
    expect(block.textContent).toContain('• Fixed the badge.');
    expect(within(sheet()).getByRole('button', { name: 'Summarize this session again' })).toHaveTextContent('Resummarize');
  });

  it('says a summary is from before the last prompt, and offers Update', () => {
    put({ recap: { state: 'done', text: '• Old news.', at: NOW - 600_000, promptAt: NOW - 900_000 } });
    open();
    expect(within(sheet()).getByRole('region', { name: 'Summary' }).textContent).toMatch(/from before your last prompt/);
    expect(within(sheet()).getByRole('button', { name: 'Update the summary' })).toBeTruthy();
  });

  it('says why it failed and offers Try again', () => {
    put({ recap: { state: 'error', error: 'the summarizer timed out', at: NOW, promptAt: NOW - 120_000 } });
    open();
    expect(within(sheet()).getByRole('region', { name: 'Summary' }).textContent).toContain('Couldn’t summarize: the summarizer timed out.');
    expect(within(sheet()).getByRole('button', { name: 'Try the summary again' })).toBeTruthy();
  });

  it('has no button with nothing typed', () => {
    put({ promptHistory: [] });
    open();
    expect(within(sheet()).queryByRole('button', { name: /summar/i })).toBeNull();
  });
});
