/**
 * The suggestion bar above a phone keyboard (AASC-20, feature 70). It appears
 * with the keyboard, offers the user's favourite skills (read through the Mac)
 * before anything else, ranks `/` matches with favourites first — plainly when
 * the Mac has no notes — and a tap fills the box without taking its focus.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PhoneSuggestionBar from './PhoneSuggestionBar';
import { BLUR_SETTLE_MS } from './useTextareaCaret';
import { resetPhoneSkillNotesCache } from '@/lib/phoneSuggestions';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const COMMANDS = [
  { name: 'resume', kind: 'command', source: 'builtin', cli: 'claude', description: '' },
  { name: 'review', kind: 'command', source: 'builtin', cli: 'claude', description: '' },
  { name: 'retouch-current-prompt', kind: 'skill', source: 'global', cli: 'claude', description: '' },
  { name: 'krt-work', kind: 'skill', source: 'global', cli: 'claude', description: '' },
];
let favorites: unknown = { source: 'cloud', entries: [
  { key: 'claude:retouch-current-prompt', fav: true, tags: [], abbr: 'rcp' },
  { key: 'claude:krt-work', fav: true, tags: ['daily'], abbr: 'kw' },
] };
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/commands')) return new Response(JSON.stringify({ entries: COMMANDS }));
  if (url === '/api/skill-notes/favorites') return new Response(JSON.stringify(favorites));
  return new Response('{}', { status: 404 });
});

let project = 0;
function Harness({ initial = '' }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  // A fresh project per render keeps the command index cache out of the way.
  const [projectPath] = useState(() => `/p/${++project}`);
  return (
    <>
      <textarea aria-label="compose" ref={setEl} value={text} onChange={(e) => setText(e.target.value)} />
      <PhoneSuggestionBar text={text} onChange={setText} textarea={el} sessionId="s1" projectPath={projectPath} />
    </>
  );
}

const bar = () => screen.queryByRole('toolbar', { name: 'Suggestions' });
const chips = () => within(bar()!).getAllByRole('button').map((b) => b.getAttribute('aria-label'));

beforeEach(() => {
  resetPhoneSkillNotesCache();
  vi.stubGlobal('fetch', fetchMock);
  useSessionStore.setState({
    sessions: new Map([['s1', { sessionId: 's1', cliSource: 'claude' } as unknown as Session]]),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  favorites = { source: 'cloud', entries: [
    { key: 'claude:retouch-current-prompt', fav: true, tags: [], abbr: 'rcp' },
    { key: 'claude:krt-work', fav: true, tags: ['daily'], abbr: 'kw' },
  ] };
});

function type(box: HTMLTextAreaElement, value: string) {
  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(value.length, value.length);
  fireEvent.input(box);
}

describe('PhoneSuggestionBar', () => {
  it('appears with the keyboard and offers the favourites first, with / to start a command', async () => {
    render(<Harness />);
    expect(bar()).toBeNull();
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => {
      box.focus();
    });
    await waitFor(() => expect(chips()).toEqual([
      'Type a command',
      '/krt-work, favourite, abbreviation kw',
      '/retouch-current-prompt, favourite, abbreviation rcp',
    ]));
    expect(fetchMock).toHaveBeenCalledWith('/api/skill-notes/favorites');
  });

  it('ranks / matches with the favourite first, and a tap replaces the fragment and keeps focus', async () => {
    render(<Harness />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    type(box, 'please /re');
    await waitFor(() => expect(chips()[0]).toBe('/retouch-current-prompt, favourite, abbreviation rcp'));
    expect(chips().slice(1)).toEqual(['/resume', '/review']);
    const first = within(bar()!).getAllByRole('button')[0];
    // The tap's mousedown must not move focus off the box (the keyboard would drop).
    expect(fireEvent.mouseDown(first)).toBe(false);
    fireEvent.click(first);
    expect(box.value).toBe('please /retouch-current-prompt ');
  });

  it('ranks plainly when the Mac has no notes (no cloud connection)', async () => {
    favorites = { source: 'none', entries: [] };
    render(<Harness />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    await waitFor(() => expect(chips()).toEqual(['Type a command']));
    type(box, '/re');
    await waitFor(() => expect(chips()).toEqual(['/resume', '/retouch-current-prompt', '/review']));
  });

  it('inserts / as the start of a word, so the command list opens next', async () => {
    render(<Harness initial="run" />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    box.setSelectionRange(3, 3);
    fireEvent.click(await screen.findByRole('button', { name: 'Type a command' }));
    expect(box.value).toBe('run /');
    await waitFor(() => expect(chips()).toContain('/resume'));
  });

  it("lists the session's project commands when the box names no project (the terminal's)", async () => {
    useSessionStore.setState({
      sessions: new Map([['s1', { sessionId: 's1', cliSource: 'claude', projectPath: '/Users/me/shared-proj' } as unknown as Session]]),
    });
    function TerminalBox() {
      const [text, setText] = useState('');
      const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
      return (
        <>
          <textarea aria-label="compose" ref={setEl} value={text} onChange={(e) => setText(e.target.value)} />
          <PhoneSuggestionBar text={text} onChange={setText} textarea={el} sessionId="s1" />
        </>
      );
    }
    render(<TerminalBox />);
    act(() => (screen.getByLabelText('compose') as HTMLTextAreaElement).focus());
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u.startsWith('/api/commands?') && u.includes(encodeURIComponent('/Users/me/shared-proj')))).toBe(true));
  });

  it('a / chip never glues itself to the next word', async () => {
    render(<Harness initial="fix bar" />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    box.setSelectionRange(3, 3);
    fireEvent.click(await screen.findByRole('button', { name: 'Type a command' }));
    expect(box.value).toBe('fix / bar');
  });

  // Oct 21 2026: a tap on a button under the box blurs it first; a bar that vanished at once
  // moved that button 54 px up before the click landed, and the tap missed. It waits out a tap.
  it('goes away with the keyboard, once a tap that blurred the box has landed', async () => {
    render(<Harness />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    await waitFor(() => expect(bar()).not.toBeNull());
    vi.useFakeTimers();
    try {
      act(() => box.blur());
      expect(bar()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS - 1); });
      expect(bar()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(bar()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays when focus comes back before it settles (no flicker while typing)', async () => {
    render(<Harness />);
    const box = screen.getByLabelText('compose') as HTMLTextAreaElement;
    act(() => box.focus());
    await waitFor(() => expect(bar()).not.toBeNull());
    vi.useFakeTimers();
    try {
      act(() => box.blur());
      act(() => { vi.advanceTimersByTime(100); });
      act(() => box.focus());
      act(() => { vi.advanceTimersByTime(BLUR_SETTLE_MS); });
      expect(bar()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
