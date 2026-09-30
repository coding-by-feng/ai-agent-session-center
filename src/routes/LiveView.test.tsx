// LiveView.test.tsx — the separate AGENTS list on the LIVE page.
//
// On desktop it duplicated the session panel's own rail, so it is gone there:
// the LIVE tab opens the panel instead (see NavBar.live.test.tsx). On a phone
// (useIsMobile, ≤480px) the same list goes full-bleed and is the phone's
// session list, so it stays. The rule lives inside RobotListSidebar, so the
// 3D scene (which mounts it too) follows the same rule without its own check.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/types';

import LiveView from './LiveView';
import RobotListSidebar from '@/components/3d/RobotListSidebar';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';

function phoneWidth(isPhone: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: isPhone && query.includes('max-width: 480px'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })));
}

const session = (id: string): Session =>
  ({ sessionId: id, title: id, status: 'idle', lastActivityAt: Date.now(), events: [], promptHistory: [] } as unknown as Session);

beforeEach(() => {
  useSessionStore.setState({ sessions: new Map([['a', session('a')], ['b', session('b')]]), selectedSessionId: null });
  useSettingsStore.setState({ scene3dEnabled: false } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the AGENTS list on the LIVE page', () => {
  it('is not shown on desktop', () => {
    phoneWidth(false);
    const { container } = render(<RobotListSidebar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is shown on a phone, where it is the session list', () => {
    phoneWidth(true);
    render(<RobotListSidebar />);
    expect(screen.getByText(/Agents \(2\)/i)).toBeInTheDocument();
  });

  it('desktop LIVE page (3D off): no list, and the "3D Scene Paused" label stays visible', () => {
    phoneWidth(false);
    const { container } = render(<LiveView />);
    expect(screen.queryByText(/Agents \(/i)).toBeNull();
    const paused = screen.getByText(/3D Scene Paused/i);
    // This class hides the label on narrow screens because the full-bleed list
    // replaces it; with no list that would leave an empty page.
    expect(paused.className).not.toMatch(/scenePausedHasSidebar/);
    expect(container.querySelector('[class*="flatRoot"]')).not.toBeNull();
  });

  it('phone LIVE page (3D off): the list replaces the label, as before', () => {
    phoneWidth(true);
    render(<LiveView />);
    expect(screen.getByText(/Agents \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/3D Scene Paused/i).className).toMatch(/scenePausedHasSidebar/);
  });
});
