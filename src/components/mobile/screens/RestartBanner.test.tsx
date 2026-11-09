import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RestartBanner from './RestartBanner';
import { useRestartProgressStore } from '@/stores/restartProgressStore';
import type { RestartTrack } from '@/lib/chat/restartProgress';

function show(over: Partial<RestartTrack>) {
  const track: RestartTrack = { sessionId: 's1', name: 'KTS', cli: 'Claude', phase: 'stopping', terminalId: null, error: null, startedAt: 1, ...over };
  useRestartProgressStore.setState({ tracks: new Map([['s1', track]]) });
  return render(<RestartBanner sessionId="s1" />);
}

afterEach(() => useRestartProgressStore.getState().reset());

describe('RestartBanner', () => {
  it('shows nothing when this session isn’t restarting', () => {
    useRestartProgressStore.setState({ tracks: new Map() });
    const { container } = render(<RestartBanner sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('step 1: stopping the agent (no name: the header says it)', () => {
    show({ phase: 'stopping' });
    expect(screen.getByRole('status')).not.toHaveTextContent('KTS');
    expect(screen.getByRole('status')).toHaveTextContent(/^Restarting/);
    expect(screen.getByRole('status')).toHaveTextContent('Stopping the agent…');
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });

  it('step 2: starting the CLI in the new terminal', () => {
    show({ phase: 'starting', terminalId: 'term-new' });
    expect(screen.getByRole('status')).toHaveTextContent('Starting Claude in a new terminal…');
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('done: says so, with the note when there is one', () => {
    show({ phase: 'done' });
    expect(screen.getByRole('status')).toHaveTextContent(/^Restarted/);
    expect(screen.getByRole('status')).toHaveTextContent('Same conversation, new terminal.');
    show({ phase: 'done', cli: 'Codex', error: 'Codex reports in with its next message.' });
    expect(screen.getAllByRole('status')[1]).toHaveTextContent('Codex reports in with its next message.');
  });

  it('failed: an alert with the reason, kept until dismissed', () => {
    show({ phase: 'failed', error: 'The Mac couldn’t restart it. Use Resume in Info to try again.' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/^Didn’t restart/);
    expect(alert).toHaveTextContent('Use Resume in Info');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useRestartProgressStore.getState().tracks.has('s1')).toBe(false);
  });

  it('tells the store it is on screen while mounted', () => {
    const { unmount } = show({ phase: 'starting' });
    expect(useRestartProgressStore.getState().shown.get('s1')).toBe(1);
    unmount();
    expect(useRestartProgressStore.getState().shown.has('s1')).toBe(false);
  });
});
