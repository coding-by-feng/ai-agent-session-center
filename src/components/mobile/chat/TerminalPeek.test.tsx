// TerminalPeek.test.tsx — Chat's live terminal preview (AASC-41) and, since the
// terminal left the tabs (AASC-56), its "Open terminal" button: tap the preview
// to see twelve lines and the button, which opens the terminal screen.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TerminalPeek from './TerminalPeek';

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

describe('TerminalPeek', () => {
  it('shows the last three lines, twelve once tapped', async () => {
    const user = userEvent.setup();
    render(<TerminalPeek terminalId="term-1" lines={LINES} onOpenTerminal={vi.fn()} />);
    const peek = screen.getByTestId('chat-terminal-peek');
    expect(peek.textContent).toContain('line 20');
    expect(peek.textContent).not.toContain('line 17');
    await user.click(peek);
    expect(peek).toHaveAttribute('aria-expanded', 'true');
    expect(peek.textContent).toContain('line 9');
  });

  it('offers "Open terminal" on the opened preview', async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    render(<TerminalPeek terminalId="term-1" lines={LINES} onOpenTerminal={onOpenTerminal} />);
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull();
    await user.click(screen.getByTestId('chat-terminal-peek'));
    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('offers no button without a terminal', async () => {
    const user = userEvent.setup();
    render(<TerminalPeek terminalId={null} lines={[]} onOpenTerminal={vi.fn()} />);
    await user.click(screen.getByTestId('chat-terminal-peek'));
    expect(screen.getByText('No terminal for this session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull();
  });
});
