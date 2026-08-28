import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SelectionPopup from './SelectionPopup';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { ExtractedSelection } from '@/lib/selectionExtractors';
import type { Session } from '@/types';

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

/** A minimal Window stand-in for the preopened popup — tracks .close() and
 *  .location.href assignment so tests can assert on them, same shape
 *  popoutTerminalWindow.test.ts uses. jsdom's REAL window.open is an
 *  unimplemented no-op that only logs a warning; every test here stubs it so
 *  (a) that noise doesn't clutter every run, and (b) the new preopen-before-
 *  fetch behavior is actually observable — the spy records each fake window
 *  it handed out, in call order, via `spy.mock.results[n].value`. */
function stubWindowOpen(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => {
    let closed = false;
    return {
      get closed() { return closed; },
      close: vi.fn(() => { closed = true; }),
      location: { href: '' },
    };
  });
  // vi.stubGlobal (not a direct window.open assignment) so the existing
  // vi.unstubAllGlobals() in this file's afterEach restores it automatically
  // — same pattern already used here for `fetch`.
  vi.stubGlobal('open', spy);
  return spy;
}

/** Like stubFetchOk, but also serves /api/codex/models — needed once the
 *  origin is a Codex session, since the quick-settings row fetches the live
 *  catalog on mount. */
function stubFetchWithCodexModels(models: Array<{ id: string; displayName: string; isDefault?: boolean }>) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/codex/models')) {
      return {
        ok: true,
        json: async () => ({
          models: models.map((m) => ({ description: '', isDefault: false, ...m })),
          refreshedAt: new Date(0).toISOString(),
          source: 'codex-app-server',
          stale: false,
        }),
      };
    }
    return { ok: true, json: async () => ({ terminalId: 't-1', label: 'Custom: refactor' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Minimal Session mock — same cast-through-unknown pattern as
 *  AutocompleteTextarea.test.tsx's seedSession (real Session has many more
 *  required fields no test here reads). */
function seedSession(id: string, fields: Partial<Session>): void {
  const session = { sessionId: id, ...fields } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([[id, session]]) });
}

describe('SelectionPopup — custom prompt mode', () => {
  beforeEach(() => {
    stubFetchOk();
    stubWindowOpen();
    // A successful spawn calls openFloat → mutates the shared store singleton.
    // Reset it before AND after so this test neither inherits nor leaks floats
    // into other suites (e.g. workspaceSnapshot's restore tests read floats).
    useFloatingSessionsStore.setState({ floats: [] });
    // No seeded session in this describe block → cli falls back to 'claude',
    // so the quick-settings row renders its Combobox branch (not Codex's
    // fetch-driven Select) and never touches the network.
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
  });
  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
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

describe('SelectionPopup — preopens a window before the async spawn (popup-block fix)', () => {
  // The bug this covers: spawn() used to await fetch('/api/sessions/spawn-
  // floating') BEFORE its only window.open() call. That's a real network
  // round trip, and by the time it resolved, Chrome's transient activation
  // (the grace period a window.open() is still trusted as user-initiated) had
  // expired — so the popup got blocked close to every time. The fix opens a
  // placeholder window synchronously, as part of the click, before that await.
  beforeEach(() => {
    stubFetchOk();
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
  });
  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('calls window.open synchronously, before the spawn fetch resolves', () => {
    const openSpy = stubWindowOpen();
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));

    // No `await`/`waitFor` here on purpose: this assertion has to be true
    // BEFORE the fetch promise has any chance to resolve, or it isn't
    // actually proving the call happened inside the synchronous click.
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url] = openSpy.mock.calls[0] as [string];
    expect(url).toMatch(/^data:text\/html,/); // the loading placeholder, not the real popout URL yet
  });

  it('navigates the preopened window to the real URL once spawn resolves', async () => {
    const openSpy = stubWindowOpen();
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // Exactly ONE window.open call for the whole spawn — the real window is
    // the SAME preopened one, navigated, not a second freshly-opened one.
    expect(openSpy).toHaveBeenCalledTimes(1);
    const preopened = openSpy.mock.results[0]!.value as { location: { href: string } };
    expect(preopened.location.href).toContain('popout=terminal');
    expect(preopened.location.href).toContain('terminalId=t-1');
  });

  it('closes the preopened window if the spawn request fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'boom' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const openSpy = stubWindowOpen();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));

    // Otherwise a failed spawn strands a "Starting session…" tab forever.
    await waitFor(() => {
      const preopened = openSpy.mock.results[0]!.value as { closed: boolean };
      expect(preopened.closed).toBe(true);
    });
  });

  it('skips preopening entirely when the docked target is preferred', async () => {
    useSettingsStore.setState({ selectionSpawnTarget: 'docked' });
    const openSpy = stubWindowOpen();
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // No point flashing a placeholder window open only to abandon it when the
    // user has chosen to always dock.
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('SelectionPopup — quick settings (Model/Effort)', () => {
  beforeEach(() => {
    stubWindowOpen();
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
  });
  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    useSessionStore.setState({ sessions: new Map() });
    useSettingsStore.setState({
      selectionSpawnModel: '', selectionSpawnCodexModel: '', selectionSpawnEffort: '',
      selectionSpawnTarget: 'window',
    });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('defaults to no override — spawn payload omits model/effortLevel (today\'s inherit-from-origin behavior)', async () => {
    stubFetchOk();
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const spawnCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/sessions/spawn-floating'));
    const body = JSON.parse((spawnCall![1] as RequestInit).body as string);
    expect(body.model).toBeUndefined();
    expect(body.effortLevel).toBeUndefined();
  });

  it('a Claude origin shows Model + Effort Comboboxes, and a picked value flows into the spawn payload', async () => {
    stubFetchOk();
    seedSession('s1', { cliSource: 'claude' });
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);

    // Both controls present; picking Model + Effort persists to settingsStore
    // (remembered across popups) as well as flowing into this spawn's payload.
    fireEvent.change(screen.getByPlaceholderText('Model'), { target: { value: 'sonnet' } });
    fireEvent.change(screen.getByPlaceholderText('Effort'), { target: { value: 'xhigh' } });
    expect(useSettingsStore.getState().selectionSpawnModel).toBe('sonnet');
    expect(useSettingsStore.getState().selectionSpawnEffort).toBe('xhigh');

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const spawnCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/sessions/spawn-floating'));
    const body = JSON.parse((spawnCall![1] as RequestInit).body as string);
    expect(body.model).toBe('sonnet');
    expect(body.effortLevel).toBe('xhigh');
  });

  it('a Codex origin shows a Model-only Select (live catalog) with no Effort control', async () => {
    stubFetchWithCodexModels([
      { id: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', isDefault: true },
      { id: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini' },
    ]);
    seedSession('s1', { cliSource: 'codex' });
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={vi.fn()} />);

    // Catalog fetch resolves asynchronously — wait for the Select to replace
    // the "Loading Codex models…" placeholder.
    await waitFor(() => expect(screen.queryByText(/Loading Codex models/i)).not.toBeInTheDocument());
    expect(screen.queryByPlaceholderText('Model')).not.toBeInTheDocument(); // Claude's Combobox
    expect(screen.queryByPlaceholderText('Effort')).not.toBeInTheDocument(); // Codex has no effort concept

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/codex/models'))).toBe(true);
  });

  it('a Codex model pick flows into the spawn payload as model, never effortLevel', async () => {
    stubFetchWithCodexModels([{ id: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', isDefault: true }]);
    seedSession('s1', { cliSource: 'codex' });
    const onClose = vi.fn();
    render(<SelectionPopup selection={mkSelection()} originSessionId="s1" onClose={onClose} />);
    await waitFor(() => expect(screen.queryByText(/Loading Codex models/i)).not.toBeInTheDocument());

    // Select is a custom combobox (src/components/ui/Select.tsx), not a
    // native <select>. Its trigger opens on click, but options select on
    // mousedown (with preventDefault, same as Combobox) — a plain
    // fireEvent.click on the option never fires the mousedown handler.
    fireEvent.click(screen.getByTitle('Model'));
    fireEvent.mouseDown(await screen.findByText('GPT-5.1 Codex Max'));
    expect(useSettingsStore.getState().selectionSpawnCodexModel).toBe('gpt-5.1-codex-max');

    fireEvent.change(screen.getByPlaceholderText(/Custom prompt \+ selection/i), {
      target: { value: 'refactor this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run custom prompt' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const spawnCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/sessions/spawn-floating'));
    const body = JSON.parse((spawnCall![1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-5.1-codex-max');
    expect(body.effortLevel).toBeUndefined();
  });
});
