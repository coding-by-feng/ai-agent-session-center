// TerminalActionsSheet.test.tsx — the terminal toolbar's actions on a phone (AASC-18).
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TerminalActionsSheet, { type TerminalActionsSheetProps } from './TerminalActionsSheet';

function setup(over: Partial<TerminalActionsSheetProps> = {}) {
  const props: TerminalActionsSheetProps = {
    open: true,
    onClose: vi.fn(),
    onPaste: vi.fn(),
    onScrollToBottom: vi.fn(),
    autoScrollEnabled: false,
    onToggleAutoScroll: vi.fn(),
    widthMode: 'pan',
    onToggleWidthMode: vi.fn(),
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    onRefresh: vi.fn(),
    onClear: vi.fn(),
    onReconnect: vi.fn(),
    ...over,
  };
  const view = render(<TerminalActionsSheet {...props} />);
  return { props, ...view };
}

describe('TerminalActionsSheet', () => {
  it('clear output asks first and clears only on confirm', () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear output…' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onClear).not.toHaveBeenCalled();
    rerender(<TerminalActionsSheet {...props} open={false} />);
    const dialog = screen.getByRole('dialog', { name: 'Clear the terminal output?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear output' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it('cancelling the clear leaves the output alone', () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear output…' }));
    rerender(<TerminalActionsSheet {...props} open={false} />);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(props.onClear).not.toHaveBeenCalled();
  });

  it('runs paste, refresh, reconnect, scroll and full screen, closing the sheet first', () => {
    const { props } = setup();
    for (const [name, handler] of [
      ['Paste clipboard', props.onPaste],
      ['Refresh output', props.onRefresh],
      ['Reconnect terminal', props.onReconnect!],
      ['Scroll to the bottom', props.onScrollToBottom],
      ['Full screen', props.onToggleFullscreen],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(handler).toHaveBeenCalledTimes(1);
    }
    expect(props.onClose).toHaveBeenCalledTimes(5);
  });

  it('shows the toggles\' state in words', () => {
    setup({ autoScrollEnabled: true, widthMode: 'pan' });
    expect(screen.getByRole('button', { name: /Follow new output/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Wrap long lines/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves out fork and clone when the terminal has none', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Fork session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clone session' })).toBeNull();
  });
});
