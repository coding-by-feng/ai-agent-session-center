import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FloatingTerminalPanel from './FloatingTerminalPanel';

// Capture the props TerminalContainer receives — we only care that the panel
// forwards the ORIGIN session id (not its own terminalId) so the float's
// translate/explain features resolve a real, selectable session.
vi.mock('@/components/terminal/TerminalContainer', () => ({
  default: ({
    terminalId,
    originSessionId,
  }: {
    terminalId: string;
    originSessionId?: string | null;
  }) => (
    <div
      data-testid="terminal-container"
      data-terminal={terminalId}
      data-origin={originSessionId ?? ''}
    />
  ),
}));

// Tooltip just wraps children; render them directly.
vi.mock('@/components/ui/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Avoid pulling the 3D geometry module (PALETTE is only used for the pill accent).
vi.mock('@/lib/robot3DGeometry', () => ({ PALETTE: ['#ffffff'] }));

describe('FloatingTerminalPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('forwards the origin session id (not its own terminalId) to TerminalContainer', () => {
    render(
      <FloatingTerminalPanel
        terminalId="term-float-9"
        label="Explain (中文)"
        stackIndex={0}
        originSessionId="main-session-1"
        onClose={vi.fn()}
      />,
    );

    const tc = screen.getByTestId('terminal-container');
    // Hosts the float's own PTY…
    expect(tc).toHaveAttribute('data-terminal', 'term-float-9');
    // …but resolves translate/explain features against the ORIGIN session.
    expect(tc).toHaveAttribute('data-origin', 'main-session-1');
    expect(tc).not.toHaveAttribute('data-origin', 'term-float-9');
  });

  it('forwards an empty origin when the panel has none (translate features stay disabled)', () => {
    render(
      <FloatingTerminalPanel
        terminalId="term-float-9"
        label="Explain"
        stackIndex={0}
        onClose={vi.fn()}
      />,
    );

    const tc = screen.getByTestId('terminal-container');
    expect(tc).toHaveAttribute('data-origin', '');
  });
});
