import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import UpdateReadyBanner from './UpdateReadyBanner';
import type { AppUpdateState, AppUpdatesAPI } from '@/types/electron';

function installApi(initial: AppUpdateState) {
  let listener: ((s: AppUpdateState) => void) | null = null;
  const updates: AppUpdatesAPI = {
    getState: vi.fn(async () => initial),
    check: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    onState: vi.fn((cb) => { listener = cb; return () => { listener = null; }; }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { updates };
  return { updates, push: (s: AppUpdateState) => act(() => listener?.(s)) };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('UpdateReadyBanner', () => {
  it('stays hidden until an update is staged', async () => {
    const { push } = installApi({ status: 'downloading', version: '2.10.75', percent: 40, autoCheck: true });
    render(<UpdateReadyBanner />);
    await act(async () => {});
    expect(screen.queryByText(/is ready/)).toBeNull();
    push({ status: 'ready', version: '2.10.75', autoCheck: true });
    expect(screen.getByText('Version 2.10.75 is ready')).toBeTruthy();
  });

  it('Restart Now asks the main process to install; Later hides it for that version', async () => {
    const { updates, push } = installApi({ status: 'ready', version: '2.10.75', autoCheck: true });
    render(<UpdateReadyBanner />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Restart Now' }));
    expect(updates.install).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText(/is ready/)).toBeNull();
    push({ status: 'ready', version: '2.10.76', autoCheck: true });
    expect(screen.getByText('Version 2.10.76 is ready')).toBeTruthy();
  });

  it('renders nothing in a browser, where there is no electronAPI', () => {
    const { container } = render(<UpdateReadyBanner />);
    expect(container.firstChild).toBeNull();
  });
});
