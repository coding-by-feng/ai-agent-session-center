// StatusStrip.test.tsx — the strip's Stop is the phone's only Stop (Oct 20 2026). Since Nov 5
// 2026 one tap writes Esc at once, a running tool included: the confirm sheet made it two taps.
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

  it('writes Esc at once while a tool runs too: no confirm sheet', async () => {
    renderStrip(session({ events: [toolEvent('Bash: npm test')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent (Esc)' }));
    await vi.waitFor(() => expect(writeTerminal).toHaveBeenCalledWith('term-1', '\x1b'));
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Stop Claude?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
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

  it('offers Stop again after 5 s if the agent is still working', async () => {
    renderStrip(turn(T0 - 5_000));
    await tapStop();
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.getByRole('button', { name: 'Stopping…' })).toHaveAttribute('aria-busy', 'true');
    act(() => { vi.advanceTimersByTime(1_000); });
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

// Nov 6 2026: Claude holds a prompt sent while its Stop hooks still run. The strip says so,
// timed from the Stop, instead of vanishing on "Finished".
describe('StatusStrip — Finishing up', () => {
  it('names the Stop hooks and times them from the Stop, with no tool', () => {
    const stoppedAt = Date.now() - 12_000;
    renderStrip(session({
      status: 'waiting',
      stopHooksSince: stoppedAt,
      events: [toolEvent('Bash: npm test')],
      toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: stoppedAt - 1000 }] as Session['toolLog'],
    }));
    expect(screen.getByTestId('chat-status-strip')).toHaveTextContent('Finishing up · Stop hooks');
    expect(screen.getByTestId('chat-status-strip')).toHaveTextContent('0:12');
    expect(screen.getByTestId('chat-status-strip')).not.toHaveTextContent('Bash');
  });

  it('offers no Stop: Esc would cancel the user\'s own Stop hooks, and the answer is in', () => {
    renderStrip(session({ status: 'waiting', stopHooksSince: Date.now() - 3_000 }));
    expect(screen.queryByRole('button', { name: 'Stop the agent (Esc)' })).toBeNull();
  });

  it('draws nothing once the mark is stale, rather than "Working" on a finished turn', () => {
    const { container } = renderStrip(session({
      status: 'waiting',
      stopHooksSince: Date.now() - 4 * 60_000,
      toolLog: [{ tool: 'Bash', input: 'npm test', timestamp: Date.now() - 5 * 60_000 }] as Session['toolLog'],
    }));
    expect(container).toBeEmptyDOMElement();
  });
});
