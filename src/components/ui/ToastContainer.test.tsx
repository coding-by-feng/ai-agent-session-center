/**
 * Toasts are fire-and-forget; an action (e.g. "Restore") is the one way to act
 * on one. The action must run once and take its toast with it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ToastContainer, { showToast } from './ToastContainer';

afterEach(() => cleanup());

describe('ToastContainer', () => {
  it('shows a plain toast with no button', () => {
    render(<ToastContainer />);
    act(() => showToast('Saved', 'success'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('an action runs once and dismisses its toast', async () => {
    render(<ToastContainer />);
    const onClick = vi.fn();
    act(() => showToast('Uninstalled tdd', 'success', 10_000, { label: 'Restore', onClick }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restore' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Uninstalled tdd')).not.toBeInTheDocument();
  });

  it('a double click still runs the action once', async () => {
    render(<ToastContainer />);
    const onClick = vi.fn();
    act(() => showToast('Uninstalled tdd', 'success', 10_000, { label: 'Restore', onClick }));
    await userEvent.setup().dblClick(screen.getByRole('button', { name: 'Restore' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
