import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import PopoutSessionView from './PopoutSessionView';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';

// The pop-out is a thin shell around DetailPanel; what it owes the panel is the boot the full <App> would give it.
// The panel itself (and the file chooser) are stubbed: they have their own tests.
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/hooks/useSettingsInit', () => ({ useSettingsInit: vi.fn() }));
vi.mock('./DetailPanel', () => ({ default: () => <div data-testid="detail-panel" /> }));
vi.mock('./FileOpenChooser', () => ({ default: () => null }));

describe('PopoutSessionView', () => {
  const realSelectSession = useSessionStore.getState().selectSession;
  let selectSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(useWebSocket).mockClear();
    vi.mocked(useSettingsInit).mockClear();
    selectSession = vi.fn();
    useSessionStore.setState({ selectSession } as never);
    window.history.pushState({}, '', '/?popout=session&sessionId=s1');
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    window.history.pushState({}, '', '/');
  });

  it('boots the way the other pop-outs do: the user\'s settings and a token-less WebSocket', () => {
    render(<PopoutSessionView />);
    expect(useSettingsInit).toHaveBeenCalled();
    expect(useWebSocket).toHaveBeenCalledWith(null);
  });

  it('selects the session named in the URL and renders the panel', () => {
    render(<PopoutSessionView />);
    expect(selectSession).toHaveBeenCalledWith('s1');
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });

  // Toasts publish to whichever ToastContainer is mounted, and the app-level one lives in App.tsx — so in this
  // window every toast the panel raises (a launch from a project frame, a control-bar action, …) was dropped,
  // and an error such as "Directory not found" left the user clicking at a button that appeared to do nothing.
  it('shows the toasts the panel raises — the app-level container is not mounted in this window', async () => {
    render(<PopoutSessionView />);
    act(() => showToast('Directory not found: /w/gone', 'error', 5000));
    expect(await screen.findByText('Directory not found: /w/gone')).toBeInTheDocument();
  });
});
