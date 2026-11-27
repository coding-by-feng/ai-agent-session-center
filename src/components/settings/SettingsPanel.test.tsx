import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// What vite.config.ts `define`s in a real build (src/lib/appVersion.ts reads them on import).
vi.hoisted(() => {
  Object.assign(globalThis, {
    __AASC_VERSION__: '2.10.58',
    __AASC_BUILD__: { date: '2026-10-26T02:40:00.000Z', commit: 'f129192-dirty' },
  });
});

import SettingsPanel, { SettingsButton } from './SettingsPanel';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';

// Mock sub-components
vi.mock('./ThemeSettings', () => ({
  default: () => <div data-testid="theme-settings">Theme Settings</div>,
}));
vi.mock('./SoundSettings', () => ({
  default: () => <div data-testid="sound-settings">Sound Settings</div>,
}));
vi.mock('./HookSettings', () => ({
  default: () => <div data-testid="hook-settings">Hook Settings</div>,
}));
vi.mock('./ApiKeySettings', () => ({
  default: () => <div data-testid="api-key-settings">API Key Settings</div>,
}));

// Mock Modal to just render children when active
vi.mock('@/components/ui/Modal', () => ({
  default: ({ modalId, children, title }: { modalId: string; children: React.ReactNode; title?: string }) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const activeModal = useUiStore((s) => s.activeModal);
    if (activeModal !== modalId) return null;
    return (
      <div data-testid="modal" role="dialog" aria-label={title}>
        {title && <h3>{title}</h3>}
        {children}
      </div>
    );
  },
}));

describe('SettingsPanel', () => {
  beforeEach(() => {
    useUiStore.setState({ activeModal: null });
    useSettingsStore.setState({ autosaveVisible: false });
  });

  it('renders nothing when modal is not open', () => {
    const { container } = render(<SettingsPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('renders when settings modal is open', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows appearance tab by default', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    expect(screen.getByTestId('theme-settings')).toBeInTheDocument();
  });

  it('switches to sound tab on click', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('SOUND'));
    expect(screen.getByTestId('sound-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-settings')).not.toBeInTheDocument();
  });

  it('switches to hooks tab', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('HOOKS'));
    expect(screen.getByTestId('hook-settings')).toBeInTheDocument();
  });

  it('switches to API keys tab', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('API KEYS'));
    expect(screen.getByTestId('api-key-settings')).toBeInTheDocument();
  });

  it('switches to advanced tab with export/import/reset', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    fireEvent.click(screen.getByText('ADVANCED'));
    expect(screen.getByText('Export Settings')).toBeInTheDocument();
    expect(screen.getByText('Import Settings')).toBeInTheDocument();
    expect(screen.getByText('Reset to Defaults')).toBeInTheDocument();
  });

  it('opens ADVANCED on About: the AASC version and build, with a copy for bug reports', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, userAgent: navigator.userAgent, clipboard: { writeText } });
    try {
      useUiStore.setState({ activeModal: 'settings' });
      render(<SettingsPanel />);
      fireEvent.click(screen.getByText('ADVANCED'));
      const about = screen.getByRole('region', { name: 'About' });
      // The first section of the tab.
      expect(about.parentElement?.firstElementChild).toBe(about);
      expect(within(about).getByText('2.10.58')).toBeInTheDocument();
      expect(within(about).getByText(/· f129192-dirty$/)).toBeInTheDocument();
      fireEvent.click(within(about).getByRole('button', { name: 'Copy version info' }));
      expect(writeText).toHaveBeenCalledWith('AASC 2.10.58 (built 2026-10-26T02:40:00.000Z, f129192-dirty)');
      expect(await within(about).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers keep-awake where this computer’s server answers, and saves the choice there (AASC-16)', async () => {
    useUiStore.setState({ activeModal: 'settings' });
    const posted: unknown[] = [];
    let local = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === '/api/config/keep-awake') {
        if (!local) return new Response('', { status: 404 });
        if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response('{"success":true}'); }
        return new Response(JSON.stringify({ success: true, data: { mode: 'busy', saved: true } }));
      }
      return new Response('{}');
    }));
    try {
      const { unmount } = render(<SettingsPanel />);
      fireEvent.click(screen.getByText('ADVANCED'));
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText('Keep this computer awake')).toBeNull();
      unmount();
      local = true;
      render(<SettingsPanel />);
      fireEvent.click(screen.getByText('ADVANCED'));
      expect(await screen.findByText('Keep this computer awake')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'While an agent is busy' })).toBeChecked();
      fireEvent.click(screen.getByRole('radio', { name: 'Always, while AASC runs' }));
      await vi.waitFor(() => expect(posted).toEqual([{ mode: 'always' }]));
      expect(screen.getByRole('radio', { name: 'Always, while AASC runs' })).toBeChecked();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has all 5 tab buttons', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<SettingsPanel />);
    expect(screen.getByText('APPEARANCE')).toBeInTheDocument();
    expect(screen.getByText('SOUND')).toBeInTheDocument();
    expect(screen.getByText('HOOKS')).toBeInTheDocument();
    expect(screen.getByText('API KEYS')).toBeInTheDocument();
    expect(screen.getByText('ADVANCED')).toBeInTheDocument();
  });
});

describe('SettingsButton', () => {
  beforeEach(() => {
    useUiStore.setState({ activeModal: null });
  });

  it('renders a settings button', () => {
    render(<SettingsButton />);
    expect(screen.getByTitle('Settings')).toBeInTheDocument();
  });

  it('opens settings modal on click', () => {
    render(<SettingsButton />);
    fireEvent.click(screen.getByTitle('Settings'));
    expect(useUiStore.getState().activeModal).toBe('settings');
  });
});
