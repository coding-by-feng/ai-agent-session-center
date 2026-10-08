// TerminalToolbar.test.tsx — the "Clear output" button.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalToolbar from './TerminalToolbar';

const base = {
  themeName: 'auto',
  onThemeChange: vi.fn(),
  onFullscreen: vi.fn(),
  onSendEscape: vi.fn(),
  onSendArrowUp: vi.fn(),
  onSendArrowDown: vi.fn(),
  onSendEnter: vi.fn(),
  onPaste: vi.fn(),
  isFullscreen: false,
};

describe('TerminalToolbar — Clear output', () => {
  it('is an icon button named for screen readers, and calls back on click', () => {
    const onClearOutput = vi.fn();
    render(<TerminalToolbar {...base} onRefreshOutput={vi.fn()} onClearOutput={onClearOutput} />);
    const clear = screen.getByRole('button', { name: 'Clear output' });
    expect(clear.textContent).toBe('');
    expect(clear.querySelector('svg')).not.toBeNull();
    fireEvent.click(clear);
    expect(onClearOutput).toHaveBeenCalledTimes(1);
  });

  it('sits right after Refresh, its nearest relative', () => {
    render(<TerminalToolbar {...base} onRefreshOutput={vi.fn()} onClearOutput={vi.fn()} />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    const refresh = names.indexOf('Refresh terminal');
    expect(refresh).toBeGreaterThanOrEqual(0);
    expect(names[refresh + 1]).toBe('Clear output');
  });

  it('is not offered without a handler', () => {
    render(<TerminalToolbar {...base} onRefreshOutput={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear output' })).toBeNull();
  });
});

describe('TerminalToolbar — Restart session', () => {
  it('is an icon button named for screen readers, and calls back on click', () => {
    const onRestart = vi.fn();
    render(<TerminalToolbar {...base} onRestart={onRestart} />);
    const restart = screen.getByRole('button', { name: 'Restart session' });
    expect(restart.textContent).toBe('');
    expect(restart.querySelector('svg')).not.toBeNull();
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('sits right after Clear output, before Clone, and apart from the Refresh arrow it must not be mistaken for', () => {
    render(<TerminalToolbar {...base} onRefreshOutput={vi.fn()} onClearOutput={vi.fn()} onRestart={vi.fn()} onClone={vi.fn()} />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    const clear = names.indexOf('Clear output');
    expect(names[clear + 1]).toBe('Restart session');
    expect(names[clear + 2]).toBe('Clone session');

    const glyph = (label: string) => screen.getByRole('button', { name: label }).querySelector('svg')!.innerHTML;
    expect(glyph('Restart session')).not.toBe(glyph('Refresh terminal'));
  });

  it('is not offered without a handler', () => {
    render(<TerminalToolbar {...base} onRefreshOutput={vi.fn()} onClearOutput={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Restart session' })).toBeNull();
  });

  it('is disabled and marked busy while a restart is pending, so it cannot be fired twice', () => {
    const onRestart = vi.fn();
    render(<TerminalToolbar {...base} onRestart={onRestart} restartPending />);
    const restart = screen.getByRole('button', { name: 'Restart session' });
    expect(restart).toBeDisabled();
    expect(restart).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(restart);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('is enabled and not busy otherwise', () => {
    render(<TerminalToolbar {...base} onRestart={vi.fn()} />);
    const restart = screen.getByRole('button', { name: 'Restart session' });
    expect(restart).toBeEnabled();
    expect(restart).not.toHaveAttribute('aria-busy');
  });
});
