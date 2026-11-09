import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AppErrorBoundary from './AppErrorBoundary';

function Boom(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/ChatView-old.js');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <AppErrorBoundary onReload={() => {}}>
        <p>fine</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
  });

  it('shows a reload screen instead of an empty page when a screen fails to load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReload = vi.fn();
    render(
      <AppErrorBoundary onReload={onReload}>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText("AASC couldn't load this screen")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
