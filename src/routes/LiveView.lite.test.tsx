// LiveView.lite.test.tsx — the Lite build has no 3D scene, even when the shared settings have it on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/components/3d/CyberdromeScene', () => ({ default: () => <div data-testid="scene" /> }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));

import LiveView from './LiveView';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';

describe('LiveView in the Lite build', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })));
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({ scene3dEnabled: true } as never);
    useWsStore.setState({ snapshotReceived: true, connected: true });
    useUiStore.setState({ workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' }, workspaceRestorePending: false } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stays flat when Full left 3D switched on in the shared settings', () => {
    render(<LiveView />);
    expect(screen.queryByTestId('scene')).not.toBeInTheDocument();
  });

  it('does not offer to turn 3D on', () => {
    useSettingsStore.setState({ scene3dEnabled: false } as never);
    render(<LiveView />);
    expect(screen.getByRole('heading', { name: /no .*sessions yet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on 3D' })).not.toBeInTheDocument();
  });
});
