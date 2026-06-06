import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SelectionPopup from './SelectionPopup';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import type { ExtractedSelection } from '@/lib/selectionExtractors';

// Avoid Dexie/IndexedDB (absent in jsdom) — the spawn awaits createLog.
vi.mock('@/lib/translationLog', () => ({
  createLog: vi.fn().mockResolvedValue('log-uuid'),
}));

function mkSelection(): ExtractedSelection {
  return {
    selection: 'const x = 1',
    contextLine: 'const x = 1;',
    anchor: { x: 100, y: 100, right: 140, bottom: 120 },
  };
}

function stubFetchOk() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ terminalId: 't-1', label: 'Custom: refactor' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SelectionPopup — custom prompt mode', () => {
  beforeEach(() => {
    stubFetchOk();
    // A successful spawn calls openFloat → mutates the shared store singleton.
    // Reset it before AND after so this test neither inherits nor leaks floats
    // into other suites (e.g. workspaceSnapshot's restore tests read floats).
    useFloatingSessionsStore.setState({ floats: [] });
  });
  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows a preview of the captured selection so it is not "lost" when the textarea steals focus', () => {
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={vi.fn()} />);
    // The captured selection is mirrored into the popup as a read-only preview.
    // Focusing the custom-prompt textarea collapses the browser's native
    // selection highlight, so this preview is what reassures the user the
    // selected text is still attached to the spawn.
    const preview = screen.getByTestId('selection-preview');
    expect(preview).toHaveTextContent('const x = 1');
  });

  it('Run is disabled until a custom prompt is typed', () => {
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={vi.fn()} />);
    const run = screen.getByRole('button', { name: 'Run custom prompt' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    const input = screen.getByPlaceholderText(/Custom prompt \+ selection/i);
    fireEvent.change(input, { target: { value: 'refactor this' } });
    expect(run.disabled).toBe(false);
  });

  it('posts mode "custom" with the typed prompt + selection, then closes', async () => {
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this for clarity' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const spawnCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/sessions/spawn-floating'),
    );
    expect(spawnCall).toBeTruthy();
    const body = JSON.parse((spawnCall![1] as RequestInit).body as string);
    expect(body.mode).toBe('custom');
    expect(body.customPrompt).toBe('refactor this for clarity');
    expect(body.selection).toBe('const x = 1');
  });

  it('Enter (without shift) runs the custom prompt', async () => {
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    const input = screen.getByPlaceholderText(/Custom prompt \+ selection/i);
    fireEvent.change(input, { target: { value: 'summarize' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/sessions/spawn-floating')),
    ).toBe(true);
  });
});
