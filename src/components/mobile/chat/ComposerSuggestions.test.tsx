// ComposerSuggestions.test.tsx — the Chat composer's list of matching commands and skills (Oct 21 2026):
// a `/prefix` (or a Codex `$prefix`) under the caret lists them above the box, on Claude and Codex alike;
// a tap puts the entry's own token in place of the fragment, and /model opens its sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone', getWindowOriginId: () => 'phone:w' }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import Composer from './Composer';
import { useSessionStore } from '@/stores/sessionStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { resetPhoneSkillNotesCache } from '@/lib/phoneSuggestions';
import { waitingCardModel } from '@/lib/chat/waitingCardModel';

const CLAUDE = [
  { name: 'model', kind: 'command', source: 'builtin', cli: 'claude', description: 'Set the AI model' },
  { name: 'review', kind: 'command', source: 'builtin', cli: 'claude', description: 'Review a pull request' },
  { name: 'krt-work', kind: 'skill', source: 'global', cli: 'claude', description: 'Work the requirement queue' },
  { name: 'krt-update', kind: 'skill', source: 'global', cli: 'claude', description: 'Change an existing item' },
];
const CODEX = [
  { name: 'review', kind: 'command', source: 'builtin', cli: 'codex', description: 'Review my changes' },
  { name: 'krt-work', kind: 'skill', source: 'global', cli: 'codex', description: 'Work the requirement queue' },
];

let project = 0;
function session(extra: Partial<Session> = {}): Session {
  // A fresh project per test keeps the command index cache (30 s) out of the way.
  return {
    sessionId: 's1', status: 'waiting', cliSource: 'claude', projectName: 'p', projectPath: `/p/${++project}`,
    terminalId: 'term-1', model: 'claude-opus-5-5', events: [], pendingRequest: null, pendingTool: null, pendingToolDetail: null, waitingDetail: null,
    ...extra,
  } as unknown as Session;
}

function renderComposer(s: Session) {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]) });
  return render(<Composer session={s} card={waitingCardModel(s)} inputRef={createRef<HTMLTextAreaElement>()} />);
}

const box = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
/** Type `text` with the caret at `caret` (default: the end), the box focused. */
function typeAt(text: string, caret = text.length) {
  const el = box();
  act(() => el.focus());
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(caret, caret);
  fireEvent.select(el);
}
const list = () => screen.queryByRole('region', { name: 'Matching commands and skills' });
const rows = () => within(list()!).getAllByRole('button').map((b) => b.textContent);
/** The saved draft (the store drops an emptied one). */
const draft = () => useComposerDraftStore.getState().drafts.s1 ?? '';

beforeEach(() => {
  resetPhoneSkillNotesCache();
  useComposerDraftStore.setState({ drafts: {} });
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/commands')) return new Response(JSON.stringify({ entries: url.includes('cli=codex') ? CODEX : CLAUDE }));
    if (url === '/api/skill-notes/favorites') return new Response(JSON.stringify({ source: 'none', entries: [] }));
    return new Response('{}');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Chat composer’s command and skill list', () => {
  it('lists the skills a typed prefix matches, mid-prompt, and a tap completes the word (the Oct 21 screenshot)', async () => {
    renderComposer(session());
    typeAt('/krt-wor take EE-86', '/krt-wor'.length);
    expect(await screen.findByRole('region', { name: 'Matching commands and skills' })).toBeInTheDocument();
    expect(rows()).toEqual(['/krt-workWork the requirement queue']);
    fireEvent.click(screen.getByRole('button', { name: /^\/krt-work/ }));
    expect(draft()).toBe('/krt-work take EE-86');
    expect(list()).toBeNull(); // the word is done
    expect(screen.queryByTestId('command-sheet')).toBeNull();
  });

  it('a typed "/" lists commands and skills in place, instead of covering the box with the sheet', async () => {
    renderComposer(session());
    typeAt('/');
    expect(await screen.findByRole('region', { name: 'Matching commands and skills' })).toBeInTheDocument();
    expect(rows().map((r) => r?.split(/[A-Z]/)[0])).toEqual(['/krt-update', '/krt-work', '/model', '/review']);
    expect(document.activeElement).toBe(box());
  });

  it('on Codex, "/" lists its skills too, each going in as $name; "$" lists skills only', async () => {
    renderComposer(session({ cliSource: 'codex', model: 'gpt-5.5' } as Partial<Session>));
    typeAt('/kr');
    expect(await screen.findByRole('button', { name: /^\$krt-work/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^\$krt-work/ }));
    expect(draft()).toBe('$krt-work ');

    typeAt('$re');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(list()).toBeNull(); // no skill matches "re"; the /review command is not a $ entry
    typeAt('$kr');
    expect(await screen.findByRole('button', { name: /^\$krt-work/ })).toBeInTheDocument();
  });

  it('a "$" on Claude is ordinary text ($HOME, a price): nothing lists', async () => {
    renderComposer(session());
    typeAt('echo $HO');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(list()).toBeNull();
  });

  it('/model opens its picker sheet, without leaving the typed fragment behind', async () => {
    renderComposer(session());
    typeAt('/mod');
    fireEvent.click(await screen.findByRole('button', { name: /^\/model/ }));
    expect(await screen.findByTestId('model-sheet')).toBeInTheDocument();
    expect(draft()).toBe('');
  });

  it('goes away when the word ends, when nothing matches, on Escape, and when the box loses focus', async () => {
    renderComposer(session());
    typeAt('/krt');
    expect(await screen.findByRole('region', { name: 'Matching commands and skills' })).toBeInTheDocument();
    typeAt('/krt ');
    expect(list()).toBeNull();
    typeAt('/zzz');
    expect(list()).toBeNull();
    typeAt('/krt');
    expect(await screen.findByRole('region', { name: 'Matching commands and skills' })).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(list()).toBeNull();
    typeAt('/krt-w'); // a new fragment start lists again only once the old one is gone: same start, still dismissed
    expect(list()).toBeNull();
    typeAt('do /krt');
    expect(await screen.findByRole('region', { name: 'Matching commands and skills' })).toBeInTheDocument();
    act(() => box().blur());
    // Not at once: a tap that blurred the box lands first (useTextareaCaret's BLUR_SETTLE_MS).
    await waitFor(() => expect(list()).toBeNull());
  });
});
