import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceAutoLoad } from './useWorkspaceAutoLoad';
import RestorePickerModal from '@/components/modals/RestorePickerModal';
import { useWsStore } from '@/stores/wsStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

function Harness() { useWorkspaceAutoLoad(); return <RestorePickerModal />; }
const requests: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  useWsStore.setState({ connected: true, snapshotReceived: true });
  useSessionStore.setState({ sessions: new Map([['live-conversation', { sessionId: 'live-conversation', terminalId: 'live-pty' } as Session]]) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    if (url.endsWith('restore-claim')) return { ok: true, json: async () => ({ granted: true }) };
    if (url.endsWith('/load')) return { ok: true, json: async () => ({ version: 1, exportedAt: Date.now(), rooms: [], sessions: [{ originalSessionId: 'term-stale', title: 'Saved Claude', sshConfig: { command: 'claude' } }] }) };
    return { ok: true, json: async () => ({ success: true, data: [] }) };
  }));
});
afterEach(() => { cleanup(); document.querySelector('meta[name="aasc-hosted-parent"]')?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps hosted live conversations intact without claiming or showing the destructive snapshot picker, including reconnect', async () => {
  const meta = document.createElement('meta'); meta.name = 'aasc-hosted-parent'; meta.content = 'https://xclaude.dev'; document.head.append(meta);
  render(<Harness />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  act(() => useWsStore.setState({ connected: false }));
  act(() => useWsStore.setState({ connected: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(requests).toEqual([]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(useSessionStore.getState().sessions.get('live-conversation')?.terminalId).toBe('live-pty');
});

it('still offers snapshot recovery for an ordinary standalone desktop', async () => {
  render(<Harness />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(requests).toContain('/api/workspace/restore-claim');
  expect(requests).toContain('/api/workspace/load');
  expect(screen.getByRole('dialog', { name: 'Restore workspace' })).toBeInTheDocument();
  expect(requests).not.toContain('/api/sessions/clear-all');
});
