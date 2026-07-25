import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FloatingTerminalPanel from './FloatingTerminalPanel';

const ORIGINAL_VIEWPORT = {
  w: window.innerWidth,
  h: window.innerHeight,
};

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
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: ORIGINAL_VIEWPORT.w,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: ORIGINAL_VIEWPORT.h,
    });
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

  it('applies the viewport constraint before rendering a saved panel', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 529,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 730,
    });
    localStorage.setItem('float-terminal-pos:term-narrow', JSON.stringify({ x: 80, y: 100 }));
    localStorage.setItem('float-terminal-size:term-narrow', JSON.stringify({ w: 540, h: 360 }));

    render(
      <FloatingTerminalPanel
        terminalId="term-narrow"
        label="Vocab (简体中文)"
        stackIndex={0}
        originSessionId="main-session-1"
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByTestId('terminal-container').parentElement?.parentElement;
    expect(panel).toHaveStyle({ left: '12px', width: '505px' });
  });

  it('re-fits the whole panel when the renderer viewport becomes narrower', async () => {
    render(
      <FloatingTerminalPanel
        terminalId="term-resize"
        label="Vocab (简体中文)"
        stackIndex={0}
        originSessionId="main-session-1"
        onClose={vi.fn()}
      />,
    );

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 529,
    });
    fireEvent(window, new Event('resize'));

    const panel = screen.getByTestId('terminal-container').parentElement?.parentElement;
    await waitFor(() => {
      expect(panel).toHaveStyle({ left: '12px', width: '505px' });
    });
  });
});
