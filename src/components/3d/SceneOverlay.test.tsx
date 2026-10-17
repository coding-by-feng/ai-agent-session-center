import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import SceneOverlay from './SceneOverlay';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRoomStore } from '@/stores/roomStore';
import { useCameraStore } from '@/stores/cameraStore';

vi.mock('@/lib/soundEngine', () => ({ soundEngine: { unlock: vi.fn() } }));

// AASC-11: the HUD moved from inline styles (hover painted from JS, no focus or
// pressed state) to a CSS module; its toggles say their state to assistive tech.
describe('SceneOverlay — the LIVE HUD', () => {
  beforeEach(() => {
    useSettingsStore.setState({ scene3dEnabled: false } as never);
    useSettingsStore.getState().updateSoundSettings({ enabled: true });
    useRoomStore.setState({ rooms: [{ id: 'r1', name: 'AASC', sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 }] });
  });

  it('shows the unit count under its caption', () => {
    render(<SceneOverlay sessionCount={21} />);
    expect(screen.getByText('Units Online')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
  });

  it('sound and 3D are toggles with a fixed name that say whether they are on', () => {
    render(<SceneOverlay sessionCount={1} />);
    const sound = screen.getByRole('button', { name: 'Sound' });
    expect(sound).toHaveAttribute('aria-pressed', 'true');
    expect(sound).toHaveTextContent('Sound On');
    fireEvent.click(sound);
    expect(screen.getByRole('button', { name: 'Sound' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Sound' })).toHaveTextContent('Muted');
    expect(screen.getByRole('button', { name: '3D scene' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers no 3D-look switch: the diorama is the only look', () => {
    useSettingsStore.setState({ scene3dEnabled: true } as never);
    render(<SceneOverlay sessionCount={1} />);
    expect(screen.queryByRole('button', { name: /3D look/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Cyberdrome|Diorama)$/i)).not.toBeInTheDocument();
  });

  it('carries no inline colours: every state lives in the stylesheet', () => {
    const { container } = render(<SceneOverlay sessionCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: /Rooms \(1\)/ }));
    for (const el of container.querySelectorAll<HTMLElement>('button, input')) {
      expect(el.getAttribute('style') ?? '').not.toMatch(/color|background|border/);
    }
  });

  it('the rooms toggle says whether the list is open', () => {
    render(<SceneOverlay sessionCount={1} />);
    const toggle = screen.getByRole('button', { name: /Rooms \(1\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('a room is a real button that flies the camera there, reachable from the keyboard', () => {
    const flyTo = vi.fn();
    useCameraStore.setState({ flyTo } as never);
    render(<SceneOverlay sessionCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: /Rooms \(1\)/ }));
    const room = screen.getByRole('button', { name: 'Show room AASC' });
    fireEvent.click(room);
    expect(flyTo).toHaveBeenCalledTimes(1);
    const row = room.parentElement as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Rename room AASC' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete room AASC' })).toBeInTheDocument();
  });
});

// Review of AASC-11: with the rooms list open the HUD grows up to 100vh - 80px,
// past the board's fixed 232px bottom gutter, and covered the last row's right card.
describe('SceneOverlay — the board keeps clear of its real height', () => {
  it('publishes its footprint as --hud-clear-bottom on its parent, and takes it back on unmount', () => {
    let notify: (() => void) | null = null;
    class FakeRO { constructor(cb: () => void) { notify = cb; } observe() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', FakeRO);
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const { container, unmount } = render(<SceneOverlay sessionCount={1} />, { container: host });
      const panel = container.querySelector<HTMLElement>('[class*="panel"]')!;
      vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect);
      notify!();
      // 400 tall + 16 from the bottom edge + a 16px gap.
      expect(host.style.getPropertyValue('--hud-clear-bottom')).toBe('432px');
      unmount();
      expect(host.style.getPropertyValue('--hud-clear-bottom')).toBe('');
      host.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
