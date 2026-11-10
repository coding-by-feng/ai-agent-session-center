import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HostedWorkspace from './HostedWorkspace';
import { useHostedControls } from './HostedConnectionMenu';
import { useWsStore } from '@/stores/wsStore';
import { useContinuationState } from '@/hooks/useWorkspaceContinuation';

beforeEach(() => {
  document.head.innerHTML = '<meta name="aasc-hosted-parent" content="https://xclaude.dev">';
  useWsStore.setState({ connected: false, snapshotReceived: false });
  useContinuationState.setState({ready:false});
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ websiteOrigin: 'https://xclaude.dev', owner: true }), {
          status: 200,
        }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = '';
});
it('announces ready only after authenticated API status and a live server snapshot', async () => {
  const parent = vi.spyOn(window.parent, 'postMessage');
  render(<HostedWorkspace needsLogin={false} />);
  await waitFor(() => expect(useHostedControls.getState().pair).toBeTypeOf('function'));
  expect(parent).not.toHaveBeenCalled();
  act(() => useWsStore.setState({ connected: true }));
  expect(parent).not.toHaveBeenCalled();
  act(() => useWsStore.setState({ snapshotReceived: true }));
  expect(parent).not.toHaveBeenCalled();
  act(() => useContinuationState.setState({ready:true}));
  await waitFor(() =>
    expect(parent).toHaveBeenCalledWith({ type: 'aasc:hosted-ready', edition:'full', editions:['lite','full'] }, 'https://xclaude.dev'),
  );
});
it('reports cookie/auth failure and provides an actionable order reentry link', async () => {
  const parent = vi.spyOn(window.parent, 'postMessage');
  render(<HostedWorkspace needsLogin />);
  expect(screen.getByRole('link', { name: 'Open xclaude.dev' })).toHaveAttribute(
    'href',
    'https://xclaude.dev',
  );
  await waitFor(() =>
    expect(parent).toHaveBeenCalledWith(
      { type: 'aasc:hosted-error', reason: 'auth_required' },
      'https://xclaude.dev',
    ),
  );
});
it('leaves ordinary native and desktop UIs untouched when hosted metadata is absent', () => {
  document.head.innerHTML = '';
  const { container } = render(<HostedWorkspace needsLogin={false} />);
  expect(container).toBeEmptyDOMElement();
  expect(fetch).not.toHaveBeenCalled();
});
