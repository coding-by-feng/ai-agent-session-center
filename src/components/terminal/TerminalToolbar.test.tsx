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
