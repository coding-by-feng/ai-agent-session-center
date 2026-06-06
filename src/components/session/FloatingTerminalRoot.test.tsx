import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import FloatingTerminalRoot from './FloatingTerminalRoot';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';

// Stub the heavy PiP panel (createPortal + xterm + localStorage). We only care
// which floats FloatingTerminalRoot decides to render, and with what stackIndex.
vi.mock('./FloatingTerminalPanel', () => ({
  default: ({
    terminalId,
    originSessionId,
    stackIndex,
  }: {
    terminalId: string;
    originSessionId?: string;
    stackIndex: number;
  }) => (
    <div
      data-testid="float-panel"
      data-terminal={terminalId}
      data-origin={originSessionId}
      data-stack={String(stackIndex)}
    />
  ),
}));

function mkFloat(terminalId: string, originSessionId: string) {
  return { terminalId, label: `L:${terminalId}`, originSessionId, createdAt: 1 };
}

function renderedTerminals(): string[] {
  return screen
    .queryAllByTestId('float-panel')
    .map((el) => el.getAttribute('data-terminal') as string);
}

describe('FloatingTerminalRoot — per-session popup scoping', () => {
  beforeEach(() => {
    useFloatingSessionsStore.setState({
      floats: [
        mkFloat('t-A1', 'A'),
        mkFloat('t-A2', 'A'),
        mkFloat('t-B1', 'B'),
      ],
    });
    useSessionStore.setState({ selectedSessionId: null, previousSessionId: null });
  });

  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ selectedSessionId: null, previousSessionId: null });
    vi.clearAllMocks();
  });

  it('renders nothing when no session is selected', () => {
    render(<FloatingTerminalRoot />);
    expect(renderedTerminals()).toEqual([]);
  });

  it('renders only the floats whose origin session is selected', () => {
    useSessionStore.setState({ selectedSessionId: 'A' });
    render(<FloatingTerminalRoot />);
    expect(renderedTerminals().sort()).toEqual(['t-A1', 't-A2']);
    expect(renderedTerminals()).not.toContain('t-B1');
  });

  it('hides the previous session\'s floats and shows the new one on switch', () => {
    useSessionStore.setState({ selectedSessionId: 'A' });
    const { rerender } = render(<FloatingTerminalRoot />);
    expect(renderedTerminals().sort()).toEqual(['t-A1', 't-A2']);

    // Switch to B — A's popups unmount, B's mounts.
    act(() => useSessionStore.setState({ selectedSessionId: 'B' }));
    rerender(<FloatingTerminalRoot />);
    expect(renderedTerminals()).toEqual(['t-B1']);

    // Switch back to A — its popups come back (store was never mutated).
    act(() => useSessionStore.setState({ selectedSessionId: 'A' }));
    rerender(<FloatingTerminalRoot />);
    expect(renderedTerminals().sort()).toEqual(['t-A1', 't-A2']);
  });

  it('recomputes stackIndex over the visible subset (0,1,…), ignoring hidden floats', () => {
    // Order floats so B's float sits between A's two — proves the index is the
    // position within the *visible* list, not the global floats array.
    useFloatingSessionsStore.setState({
      floats: [mkFloat('t-A1', 'A'), mkFloat('t-B1', 'B'), mkFloat('t-A2', 'A')],
    });
    useSessionStore.setState({ selectedSessionId: 'A' });
    render(<FloatingTerminalRoot />);

    const stacks = screen
      .queryAllByTestId('float-panel')
      .map((el) => el.getAttribute('data-stack'));
    expect(stacks).toEqual(['0', '1']);
  });

  it('renders nothing for a session that has no floats', () => {
    useSessionStore.setState({ selectedSessionId: 'C' });
    render(<FloatingTerminalRoot />);
    expect(renderedTerminals()).toEqual([]);
  });
});
