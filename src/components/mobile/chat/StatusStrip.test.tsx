// StatusStrip.test.tsx — the strip's Stop is the phone's only Stop (Oct 20 2026): Esc at
// once between tools, a confirm first while a tool runs (stopping interrupts it).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Session, SessionEvent } from '@/types';

const writeTerminal = vi.fn(async () => ({ ok: true as const }));
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
