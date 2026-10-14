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

  it('lists bookmarks; a row jumps (closing the sheet first), × removes it', () => {
    const onJump = vi.fn();
    const onRemove = vi.fn();
    const list = [
      { id: 'b2', line: 40, text: '● Bash(npm test)', createdAt: 2 },
      { id: 'b1', line: 3, text: 'Done. The tests pass.', createdAt: 1 },
    ];
    const { props } = setup({ bookmarks: { list, onJump, onRemove } });
    expect(screen.getByRole('region', { name: 'Bookmarks · 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to bookmark: Done. The tests pass.' }));
    expect(props.onClose).toHaveBeenCalled();
    expect(onJump).toHaveBeenCalledWith(list[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove bookmark: ● Bash(npm test)' }));
    expect(onRemove).toHaveBeenCalledWith('b2');
  });

  it('says how to make a bookmark when there are none', () => {
    setup({ bookmarks: { list: [], onJump: vi.fn(), onRemove: vi.fn() } });
    expect(screen.getByText('Long-press a line in the terminal to bookmark it.')).toBeTruthy();
  });

  it('reads the last answer aloud, and offers to stop while it reads', () => {
    const onToggle = vi.fn();
    const { props, rerender } = setup({ readAloud: { speaking: false, onToggle } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the last answer aloud' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalled();
    rerender(<TerminalActionsSheet {...props} readAloud={{ speaking: true, onToggle }} />);
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toBeTruthy();
  });

  it('has no full screen in a sheet that is already full height', () => {
    setup({ onToggleFullscreen: undefined });
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  it('leaves out fork and clone when the terminal has none', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Fork session' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clone session' })).toBeNull();
  });
});
