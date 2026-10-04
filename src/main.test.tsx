/**
 * main.tsx decides what a window IS the moment it loads, and two of those decisions are
 * invisible failures if they go wrong:
 *
 *  - a pop-out kind this build does not know must NOT boot the dashboard — a second dashboard runs
 *    a second queue scheduler, and every queued prompt is sent twice;
 *  - the queue float must pull the server's queues WITHOUT seeding, or it recreates, from its older
 *    IndexedDB copy, queue records the server deleted on purpose.
 *
 * The module renders at import time, so each case sets the URL and DOM, loads a fresh copy and looks
 * at what ended up on the page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

vi.mock('@/App', () => ({ default: () => <div>dashboard-app</div> }));
vi.mock('@/lib/presenceClient', () => ({ installClientIdentityHeaders: vi.fn() }));
vi.mock('@/components/session/PopoutQueueView', () => ({ default: () => <div>queue-popout-view</div> }));

async function boot(search: string) {
  window.history.pushState({}, '', `/${search}`);
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();

  // The same module instances main.tsx will import (one registry until the next reset).
  const { useQueueStore } = await import('@/stores/queueStore');
  const { useQueueHistoryStore } = await import('@/stores/queueHistoryStore');
  const { usePromptSnippetStore } = await import('@/stores/promptSnippetStore');
  const syncFromServer = vi.fn(async () => undefined);
  useQueueStore.setState({ loadFromDb: vi.fn(async () => undefined), syncFromServer });
  useQueueHistoryStore.setState({ loadFromDb: vi.fn(async () => undefined) });
  usePromptSnippetStore.setState({ loadFromDb: vi.fn(async () => undefined) });

  await import('./main');
  return { syncFromServer };
}

describe('main.tsx — what a window becomes', () => {
  beforeEach(() => {
    vi.spyOn(window, 'addEventListener');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('boots the dashboard for a plain URL, seeding from this window’s copy as before', async () => {
    const { syncFromServer } = await boot('');
    expect(await screen.findByText('dashboard-app')).toBeInTheDocument();
    expect(syncFromServer).toHaveBeenCalledTimes(1);
    expect(syncFromServer).toHaveBeenCalledWith();
  });

  it('shows a notice — and no dashboard — for a pop-out kind it does not know', async () => {
    const { syncFromServer } = await boot('?popout=timeline');

    expect(await screen.findByRole('status')).toHaveTextContent(/“timeline” view/);
    expect(screen.queryByText('dashboard-app')).toBeNull();
    // Nothing a dashboard does ran: no queue sync, and so no scheduler to send a prompt twice.
    expect(syncFromServer).not.toHaveBeenCalled();
  });

  it('pulls the queue float’s queues without seeding', async () => {
    const { syncFromServer } = await boot('?popout=queue&sessionId=s1');

    expect(await screen.findByText('queue-popout-view')).toBeInTheDocument();
    await waitFor(() => expect(syncFromServer).toHaveBeenCalledTimes(1));
    expect(syncFromServer).toHaveBeenCalledWith({ seed: false });
    expect(screen.queryByText('dashboard-app')).toBeNull();
  });
});
