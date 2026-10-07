/**
 * QueueView — the global QUEUE tab, rendered against seeded queue and session
 * stores. The store logic (add / remove / moveToSession, the echo guard) is
 * covered by queueStore.test.ts; these tests pin what this view does with it:
 * the summary line, the compose card's rules, the Move menu's contract with
 * `QueueMovePicker`, and the markup rules the tab migration set.
 *
 * `QueueMovePicker` is real, not mocked: that it lists the OTHER sessions and
 * hands focus back is the point of the Move tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import QueueView from './QueueView';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast: vi.fn(),
}));

// The shortcut hint names this platform's modifier; flip it to see both.
const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock('@/lib/shortcutKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shortcutKeys')>()),
  get isMac() {
    return platform.isMac;
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function session(id: string, projectName: string, title = ''): Session {
  return { sessionId: id, projectName, title, status: 'idle' } as unknown as Session;
}

function item(id: number, sessionId: string, text: string, createdAt = Date.now()): QueueItem {
  return { id, sessionId, text, position: 0, createdAt };
}

function seed(queues: Record<string, QueueItem[]>, sessions: Session[] = []) {
  useQueueStore.setState({ queues: new Map(Object.entries(queues)) });
  useSessionStore.setState({ sessions: new Map(sessions.map((s) => [s.sessionId, s])) });
}

const queueOf = (sessionId: string) => useQueueStore.getState().queues.get(sessionId) ?? [];

beforeEach(() => {
  platform.isMac = true;
  useQueueStore.setState({ queues: new Map(), automation: new Map(), composeDrafts: new Map() });
  useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  vi.mocked(showToast).mockClear();
  // Every store write schedules a push to the server; keep it off the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Summary line and empty state
// ---------------------------------------------------------------------------

describe('QueueView — summary line', () => {
  it('counts prompts and sessions, pluralised', () => {
    seed(
      { s1: [item(1, 's1', 'a'), item(2, 's1', 'b')], s2: [item(3, 's2', 'c')] },
      [session('s1', 'alpha'), session('s2', 'beta')],
    );
    render(<QueueView />);
    expect(screen.getByText('3 queued prompts · 2 sessions')).toBeInTheDocument();
  });

  it('uses the singular for exactly one of each', () => {
    seed({ s1: [item(1, 's1', 'a')] }, [session('s1', 'alpha')]);
    render(<QueueView />);
    expect(screen.getByText('1 queued prompt · 1 session')).toBeInTheDocument();
  });

  it('reads an empty queue as plural zero', () => {
    render(<QueueView />);
    expect(screen.getByText('0 queued prompts · 0 sessions')).toBeInTheDocument();
  });

  it('does not count a session whose queue has been emptied', () => {
    seed({ s1: [], s2: [item(1, 's2', 'a')] }, [session('s1', 'alpha'), session('s2', 'beta')]);
    render(<QueueView />);
    expect(screen.getByText('1 queued prompt · 1 session')).toBeInTheDocument();
  });

  it('does not restate the tab name as a heading', () => {
    render(<QueueView />);
    expect(screen.queryByRole('heading', { name: /prompt queue/i })).toBeNull();
  });
});

describe('QueueView — empty state', () => {
  it('says nothing is queued and where prompts come from', () => {
    render(<QueueView />);
    expect(screen.getByText('No prompts in the queue')).toBeInTheDocument();
    expect(screen.getByText("Add one above, or from a session's QUEUE tab.")).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Compose card
// ---------------------------------------------------------------------------

describe('QueueView — compose card', () => {
  const sessions = [session('s1', 'alpha', 'Fix login'), session('s2', 'beta')];
  const sessionSelect = () => screen.getByRole('combobox', { name: /session/i });
  const promptBox = () => screen.getByRole('textbox', { name: 'Prompt' });
  const addButton = () => screen.getByRole('button', { name: 'Add' });

  beforeEach(() => seed({}, sessions));

  it('offers a prompt to choose, then every session as "project — title"', () => {
    render(<QueueView />);
    const labels = within(sessionSelect()).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['Choose a session…', 'alpha — Fix login', 'beta']);
    expect(sessionSelect()).toHaveValue('');
  });

  it('keeps Add disabled until there is text and a session', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    expect(addButton()).toBeDisabled();

    await user.type(promptBox(), 'run the tests');
    expect(addButton()).toBeDisabled(); // text, but no session

    await user.selectOptions(sessionSelect(), 's1');
    expect(addButton()).toBeEnabled();

    await user.clear(promptBox());
    await user.type(promptBox(), '   ');
    expect(addButton()).toBeDisabled(); // a session, but only whitespace
  });

  it('treats a chosen session that has since gone away as no choice', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.selectOptions(sessionSelect(), 's2');
    await user.type(promptBox(), 'still here?');
    expect(addButton()).toBeEnabled();

    // s2 ends and leaves the session map
    act(() => {
      useSessionStore.setState({ sessions: new Map([['s1', sessions[0]]]) });
    });
    expect(sessionSelect()).toHaveValue('');
    expect(addButton()).toBeDisabled();
  });

  it('adds the trimmed prompt to the chosen session, then clears the text and keeps the session', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.selectOptions(sessionSelect(), 's2');
    await user.type(promptBox(), '  fix the build  ');
    await user.click(addButton());

    expect(queueOf('s2')).toHaveLength(1);
    expect(queueOf('s2')[0]).toMatchObject({ sessionId: 's2', text: 'fix the build', position: 0 });
    expect(promptBox()).toHaveValue('');
    expect(sessionSelect()).toHaveValue('s2');
    expect(addButton()).toBeDisabled();
    expect(showToast).toHaveBeenCalledWith('Prompt added to queue', 'info', 2000);
  });

  it.each([
    ['Cmd', '{Meta>}{Enter}{/Meta}'],
    ['Ctrl', '{Control>}{Enter}{/Control}'],
  ])('adds on %s+Enter from the prompt box', async (_name, keys) => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.selectOptions(sessionSelect(), 's1');
    await user.type(promptBox(), 'ship it');
    await user.keyboard(keys);

    expect(queueOf('s1').map((i) => i.text)).toEqual(['ship it']);
    expect(promptBox()).toHaveValue('');
  });

  it('leaves a plain Enter as a newline, and adds nothing without a session', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.type(promptBox(), 'line one{Enter}line two');
    expect(promptBox()).toHaveValue('line one\nline two');

    await user.keyboard('{Meta>}{Enter}{/Meta}'); // no session chosen
    expect(queueOf('s1')).toHaveLength(0);
    expect(queueOf('s2')).toHaveLength(0);
    expect(promptBox()).toHaveValue('line one\nline two');
  });

  it('shows this platform\'s shortcut as a hint, and as a sentence for a screen reader', () => {
    const { unmount } = render(<QueueView />);
    expect(screen.getByText('⌘↵ to add')).toBeInTheDocument();
    expect(promptBox()).toHaveAccessibleDescription('Press Command and Enter to add');
    unmount();

    platform.isMac = false;
    render(<QueueView />);
    expect(screen.getByText('Ctrl+↵ to add')).toBeInTheDocument();
    expect(promptBox()).toHaveAccessibleDescription('Press Control and Enter to add');
  });
});

// ---------------------------------------------------------------------------
// Session groups
// ---------------------------------------------------------------------------

describe('QueueView — session groups', () => {
  it('heads a group with its project name and title, and keeps the short id to a hover', () => {
    seed({ abcdef123456: [item(1, 'abcdef123456', 'x')] }, [session('abcdef123456', 'alpha', 'Fix login')]);
    render(<QueueView />);

    // Text content, not the computed name: jsdom trims the space at each inline
    // boundary and cannot see SectionHeader's flex layout, so it would read
    // "alpha— Fix login1 prompt" where a browser reads the rendered spacing.
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('alpha — Fix login');
    expect(heading).not.toHaveTextContent('abcdef12');
    expect(screen.getByTitle('Session abcdef12')).toBeInTheDocument();
  });

  it('falls back to the short id for a session with no project name, or one that is gone', () => {
    seed(
      { 'aaaaaaaa-1': [item(1, 'aaaaaaaa-1', 'x')], 'bbbbbbbb-2': [item(2, 'bbbbbbbb-2', 'y')] },
      [session('aaaaaaaa-1', '')],
    );
    render(<QueueView />);

    expect(screen.getByRole('heading', { level: 2, name: /aaaaaaaa/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /bbbbbbbb/ })).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('counts the prompts in the header and names each table after its session', () => {
    seed(
      { s1: [item(1, 's1', 'a'), item(2, 's1', 'b')], s2: [item(3, 's2', 'c')] },
      [session('s1', 'alpha'), session('s2', 'beta')],
    );
    render(<QueueView />);

    // The badge's screen-reader text carries the pluralised count.
    const [alpha, beta] = screen.getAllByRole('heading', { level: 2 });
    expect(alpha).toHaveTextContent(/alpha.*2 prompts$/);
    expect(beta).toHaveTextContent(/beta.*1 prompt$/);
    expect(screen.getByRole('table', { name: 'Queued prompts for alpha' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Queued prompts for beta' })).toBeInTheDocument();
  });

  it('lists a session\'s prompts in queue order, numbered from 1', () => {
    seed({ s1: [item(1, 's1', 'first'), item(2, 's1', 'second')] }, [session('s1', 'alpha')]);
    render(<QueueView />);

    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + two prompts
    expect(within(rows[1]).getAllByRole('cell')[0]).toHaveTextContent('1');
    expect(within(rows[1]).getByText('first')).toBeInTheDocument();
    expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('2');
    expect(within(rows[2]).getByText('second')).toBeInTheDocument();
  });

  it('drops a group when its last prompt is removed', async () => {
    const user = userEvent.setup();
    seed(
      { s1: [item(1, 's1', 'only')], s2: [item(2, 's2', 'other')] },
      [session('s1', 'alpha'), session('s2', 'beta')],
    );
    render(<QueueView />);
    await user.click(within(screen.getByRole('table', { name: /alpha/ })).getByRole('button', { name: /^Remove prompt \d+ from the queue$/ }));

    expect(screen.queryByRole('table', { name: /alpha/ })).toBeNull();
    expect(screen.getByRole('table', { name: /beta/ })).toBeInTheDocument();
    expect(screen.getByText('1 queued prompt · 1 session')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The Added column
// ---------------------------------------------------------------------------

describe('QueueView — the Added column', () => {
  const at = (...args: [number, number, number, number, number, number?]) => new Date(...args).getTime();

  beforeEach(() => {
    // Only the clock: user-event and Tooltip timers must keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 15, 0, 0)); // Oct 7, 2026, 15:00 local
  });

  const renderOne = (createdAt: number) => {
    seed({ s1: [item(1, 's1', 'x', createdAt)] }, [session('s1', 'alpha')]);
    render(<QueueView />);
    return within(screen.getByRole('table')).getAllByRole('cell')[2];
  };

  it('shows hours and minutes, never seconds, for a prompt added today', () => {
    expect(renderOne(at(2026, 9, 7, 9, 5, 42))).toHaveTextContent(/^09:05$/);
  });

  it('prefixes the date for a prompt added on another day', () => {
    const cell = renderOne(at(2026, 9, 6, 22, 47));
    expect(cell).toHaveTextContent(/^Oct 6, 22:47$/);
    expect(cell).not.toHaveTextContent('2026');
  });

  it('adds the year only when it is not the current one', () => {
    expect(renderOne(at(2025, 11, 31, 23, 59))).toHaveTextContent(/^Dec 31, 2025, 23:59$/);
  });

  it('reads just after midnight as 00:xx, not 24:xx', () => {
    expect(renderOne(at(2026, 9, 7, 0, 5))).toHaveTextContent(/^00:05$/);
  });

  it('hands the same string to the prompt cell, which a narrow layout shows in its place', () => {
    // Below 640px the Added column is hidden and the time is drawn under the
    // prompt from this attribute (`attr(data-added)` in Queue.module.css).
    renderOne(at(2025, 11, 31, 23, 59));
    const [, promptCell, addedCell] = within(screen.getByRole('table')).getAllByRole('cell');
    expect(promptCell).toHaveAttribute('data-added', addedCell.textContent ?? '');
    expect(promptCell).toHaveAttribute('data-added', 'Dec 31, 2025, 23:59');
  });
});

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

describe('QueueView — Move', () => {
  const sessions = [session('s1', 'alpha'), session('s2', 'beta', 'Docs'), session('s3', 'gamma')];
  const moveButtons = () => screen.getAllByRole('button', { name: /^Move prompt \d+ to another session$/ });
  const menu = () => screen.getByRole('listbox', { name: 'Move queue item to session' });

  beforeEach(() => seed({ s1: [item(1, 's1', 'first'), item(2, 's1', 'second')] }, sessions));

  it('opens a menu of every OTHER session', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);

    const labels = within(menu()).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['beta — Docs', 'gamma']);
    expect(moveButtons()[0]).toHaveAttribute('aria-expanded', 'true');
    expect(moveButtons()[1]).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks every Move button as a picker trigger, so a second click toggles it', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    for (const button of moveButtons()) expect(button).toHaveAttribute('data-queue-move-trigger');

    await user.click(moveButtons()[0]);
    expect(menu()).toBeInTheDocument();
    await user.click(moveButtons()[0]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(moveButtons()[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('hands the menu to another row rather than opening a second', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    await user.click(moveButtons()[1]);

    expect(screen.getAllByRole('listbox')).toHaveLength(1);
    expect(moveButtons()[0]).toHaveAttribute('aria-expanded', 'false');
    expect(moveButtons()[1]).toHaveAttribute('aria-expanded', 'true');
  });

  it('moves the prompt to the picked session, closes, and toasts', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    await user.click(within(menu()).getByRole('option', { name: /beta/ }));

    expect(queueOf('s1').map((i) => i.id)).toEqual([2]);
    expect(queueOf('s2')).toHaveLength(1);
    expect(queueOf('s2')[0]).toMatchObject({ id: 1, sessionId: 's2', text: 'first' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('table', { name: 'Queued prompts for beta' })).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith('Prompt moved', 'info', 2000);
  });

  it('closes on Escape and gives focus back to the Move button', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(moveButtons()[0]).toHaveFocus();
    expect(queueOf('s1')).toHaveLength(2);
  });

  it('hands focus to the next prompt after a move, not to <body>', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    await user.click(within(menu()).getByRole('option', { name: /beta/ }));

    // 'second' is now alpha's prompt 1, and its Move button holds the focus.
    const alpha = screen.getByRole('table', { name: 'Queued prompts for alpha' });
    expect(within(alpha).getByRole('button', { name: 'Move prompt 1 to another session' })).toHaveFocus();
  });

  it('gives focus back without scrolling, so closing the menu never jumps the list', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await user.keyboard('{Escape}');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('closes on a click elsewhere', async () => {
    const user = userEvent.setup();
    render(<QueueView />);
    await user.click(moveButtons()[0]);
    await user.click(screen.getByTestId('queue-view'));

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says so when there is nowhere to move to', async () => {
    const user = userEvent.setup();
    seed({ s1: [item(1, 's1', 'first')] }, [session('s1', 'alpha')]);
    render(<QueueView />);
    await user.click(moveButtons()[0]);

    expect(within(menu()).getByText('No other sessions')).toBeInTheDocument();
    expect(within(menu()).queryAllByRole('option')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe('QueueView — Remove', () => {
  it('is a named button on every row, and removes that prompt only', async () => {
    const user = userEvent.setup();
    seed({ s1: [item(1, 's1', 'first'), item(2, 's1', 'second')] }, [session('s1', 'alpha')]);
    render(<QueueView />);

    const removes = screen.getAllByRole('button', { name: /^Remove prompt \d+ from the queue$/ });
    expect(removes).toHaveLength(2);
    await user.click(removes[0]);

    expect(queueOf('s1').map((i) => i.id)).toEqual([2]);
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('hands focus to the next prompt, across session tables, then to the compose box', async () => {
    const user = userEvent.setup();
    seed(
      { s1: [item(1, 's1', 'first')], s2: [item(2, 's2', 'second')] },
      [session('s1', 'alpha'), session('s2', 'beta')],
    );
    render(<QueueView />);
    const table = (name: string) => screen.getByRole('table', { name: `Queued prompts for ${name}` });

    await user.click(within(table('alpha')).getByRole('button', { name: /^Remove prompt 1/ }));
    // alpha's table left with its only prompt; focus moved on into beta's.
    expect(within(table('beta')).getByRole('button', { name: /^Move prompt 1/ })).toHaveFocus();

    await user.click(within(table('beta')).getByRole('button', { name: /^Remove prompt 1/ }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Markup rules from the tab migration
// ---------------------------------------------------------------------------

describe('QueueView — markup', () => {
  it('keeps its test id and carries no inline style', () => {
    seed(
      { s1: [item(1, 's1', 'first')] },
      [session('s1', 'alpha', 'Fix login'), session('s2', 'beta')],
    );
    const { container } = render(<QueueView />);

    expect(screen.getByTestId('queue-view')).toBeInTheDocument();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('has one scrolling region: the view root never scrolls', () => {
    const css = readFileSync(resolve(__dirname, '../styles/modules/Queue.module.css'), 'utf8');
    const rule = (selector: string) => {
      const match = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      return match?.[1] ?? '';
    };
    expect(rule('.view')).toMatch(/overflow:\s*hidden/);
    expect(rule('.body')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.body')).toMatch(/min-height:\s*0/);
  });
});

describe('QueueView — design-rule guards', () => {
  const read = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');

  it('borrows no styles from the terminal and writes no inline style or JS hover', () => {
    const source = read('./QueueView.tsx');
    expect(source).not.toMatch(/Terminal\.module\.css/);
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/onMouse(Enter|Leave)/);
  });

  it('takes every colour from the theme variables', () => {
    const css = read('../styles/modules/Queue.module.css');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).not.toMatch(/--surface-card/);
  });

  it('draws the narrow-layout time from the attribute the row sets', () => {
    // The two ends of one contract live in different files; neither lints.
    expect(read('../styles/modules/Queue.module.css')).toMatch(/content:\s*attr\(data-added\)/);
    expect(read('./QueueView.tsx')).toMatch(/data-added=\{added\}/);
  });
});
