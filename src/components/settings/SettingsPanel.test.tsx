import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
vi.mock('./SummaryPromptSettings', () => ({
  default: () => <div data-testid="summary-prompt-settings">Summary Prompts</div>,
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
