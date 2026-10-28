// StatusStrip.test.tsx — the strip's Stop is the phone's only Stop (Oct 20 2026): Esc at
// once between tools, a confirm first while a tool runs (stopping interrupts it).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Session, SessionEvent } from '@/types';

const writeTerminal = vi.fn(async (): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true }));
vi.mock('@/lib/terminalCompose', () => ({
  PHONE_KEY_SEQUENCES: { esc: '\x1b' },
  writeTerminal: (...args: unknown[]) => writeTerminal(...(args as [])),
}));
vi.mock('@/hooks/useControlBaton', () => ({ useControlBaton: () => ({ mode: 'solo' }) }));

import StatusStrip from './StatusStrip';

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    terminalId: 'term-1',
    status: 'working',
    cliSource: 'claude',
    promptHistory: [],
    toolLog: [],
    events: [],
    lastActivityAt: Date.now(),
    ...over,
  } as unknown as Session;
}

const toolEvent = (detail: string): SessionEvent => ({ type: 'PreToolUse', detail, timestamp: Date.now() } as SessionEvent);

function renderStrip(s: Session) {
  return render(<StatusStrip session={s} peek={[]} onOpenTerminal={() => {}} />);
}

describe('StatusStrip Stop', () => {
  beforeEach(() => {
    writeTerminal.mockClear();
    localStorage.clear();
  });

  it('writes Esc at once when no tool is running', async () => {
    renderStrip(session());
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent (Esc)' }));
    await vi.waitFor(() => expect(writeTerminal).toHaveBeenCalledWith('term-1', '\x1b'));
  });

  it('asks first while a tool runs, and stops only on the confirm', async () => {
    renderStrip(session({ events: [toolEvent('Bash: npm test')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent (Esc)' }));
    expect(await screen.findByText('Stop Claude?')).toBeInTheDocument();
    expect(screen.getByText('It is running Bash. Stopping interrupts it.')).toBeInTheDocument();
    expect(writeTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(writeTerminal).toHaveBeenCalledWith('term-1', '\x1b'));
  });

  it('cancelling the confirm leaves the agent running', async () => {
    renderStrip(session({ events: [toolEvent('Bash: npm test')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent (Esc)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});

// Oct 28 2026: a tap used to show "busy" only while the Esc write was in flight
// (~100 ms), then a plain Stop again beside "Working", so nothing said it landed.
describe('StatusStrip — after Stop', () => {
  const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    writeTerminal.mockClear();
    writeTerminal.mockImplementation(async () => ({ ok: true }));
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const turn = (at: number) => session({ promptHistory: [{ text: 'go', timestamp: at }] as Session['promptHistory'] });
  const tapStop = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop the agent (Esc)' }));
    });
  };

  it('holds Stopping… once Esc is written, and the strip says Stopping', async () => {
    renderStrip(turn(T0 - 5_000));
    await tapStop();
    const button = screen.getByRole('button', { name: 'Stopping…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.textContent).toContain('Stopping…');
    expect(screen.getByTestId('chat-status-strip').textContent).toMatch(/^Stopping/);
    // Still held a few seconds later, and a second tap writes nothing more.
    act(() => { vi.advanceTimersByTime(3_000); });
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }));
    expect(writeTerminal).toHaveBeenCalledTimes(1);
  });

  it('offers Stop again after 10 s if the agent is still working', async () => {
    renderStrip(turn(T0 - 5_000));
    await tapStop();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('button', { name: 'Stop the agent (Esc)' })).not.toHaveAttribute('aria-busy');
    expect(screen.getByTestId('chat-status-strip').textContent).toMatch(/^Working/);
  });

  it('starts a new turn with a plain Stop', async () => {
    const view = renderStrip(turn(T0 - 5_000));
    await tapStop();
    view.rerender(<StatusStrip session={turn(T0 + 1_000)} peek={[]} onOpenTerminal={() => {}} />);
    expect(screen.getByRole('button', { name: 'Stop the agent (Esc)' })).toBeInTheDocument();
  });

  it('goes back to Stop with the reason when Esc could not be written', async () => {
    writeTerminal.mockImplementation(async () => ({ ok: false, message: 'The terminal has closed.' }));
    renderStrip(turn(T0 - 5_000));
    await tapStop();
    expect(screen.getByRole('button', { name: 'Stop the agent (Esc)' })).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toBe('The terminal has closed.');
  });
});
