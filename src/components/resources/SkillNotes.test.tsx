import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceSummary } from '@/types/resources';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import SkillNotes, { FavToggle } from './SkillNotes';

function res(over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: 'a1', type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    name: 'retouch-ascii-review', path: '~/.claude/skills/retouch-ascii-review', fileCount: 1, bytes: 1, mtimeMs: 0,
    repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [], ...over,
  } as ResourceSummary;
}
const REAL = new Set(['claude:retouch-ascii-review', 'claude:plan']);
const notes = () => useSkillNotesStore.getState().notes;

describe('SkillNotes card', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } useSkillNotesStore.setState({ notes: {} }); });

  it('adds several tags, shows them as chips, and removes one', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Add a tag');
    await user.type(input, 'Review{Enter}');
    await user.type(input, 'workflow{Enter}');
    expect(notes()['claude:retouch-ascii-review'].tags).toEqual(['review', 'workflow']);
    expect(screen.getByText('review')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove tag review' }));
    expect(notes()['claude:retouch-ascii-review'].tags).toEqual(['workflow']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('toggles the favourite, reporting its state to assistive tech', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const fav = screen.getByRole('button', { name: /Favourite/ });
    expect(fav.getAttribute('aria-pressed')).toBe('false');
    await user.click(fav);
    expect(notes()['claude:retouch-ascii-review'].fav).toBe(true);
    expect(screen.getByRole('button', { name: /Favourite/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves an abbreviation and clears it again', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'RAR');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(notes()['claude:retouch-ascii-review'].abbr).toBe('rar');
    await user.click(screen.getByRole('button', { name: 'Clear abbreviation' }));
    expect(notes()).toEqual({});
  });

  it('explains why an abbreviation is refused, and keeps the field', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:other': { fav: false, tags: [], abbr: 'rar' } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'rar');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(screen.getByRole('alert').textContent).toContain('already the abbreviation of other');
    expect((screen.getByLabelText('Abbreviation') as HTMLInputElement).value).toBe('rar');
    expect(notes()['claude:retouch-ascii-review']).toBeUndefined();
  });

  it('refuses the name of a real skill', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.type(screen.getByLabelText('Abbreviation'), 'plan');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect(screen.getByRole('alert').textContent).toContain('existing skill or command');
  });

  it('says the notes stay in this browser', () => {
    render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.getByText(/this browser/i)).toBeTruthy();
  });

  it('keys a plugin skill the way the prompt box names it', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res({ origin: 'plugin', pluginName: 'superpowers', name: 'brainstorming' })} realNames={REAL} />);
    await user.type(screen.getByLabelText('Add a tag'), 'ideas{Enter}');
    expect(Object.keys(notes())).toEqual(['claude:superpowers:brainstorming']);
  });
});

describe('FavToggle', () => {
  beforeEach(() => { useSkillNotesStore.setState({ notes: {} }); });

  it('is a labelled toggle on a row', async () => {
    const user = userEvent.setup();
    render(<FavToggle resource={res()} />);
    const btn = screen.getByRole('button', { name: 'Favourite retouch-ascii-review' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await user.click(btn);
    expect(within(document.body).getByRole('button', { name: 'Favourite retouch-ascii-review' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('renders nothing for a type that cannot have notes', () => {
    const { container } = render(<FavToggle resource={res({ type: 'rule' })} />);
    expect(container.textContent).toBe('');
  });
});

// ── The abbreviation as a real command in Claude Code / Codex ───────────────
describe('SkillNotes card — also work inside the CLI', () => {
  type Call = { url: string; method: string; body: unknown };
  let calls: Call[];
  let respond: (call: Call) => { status?: number; body: unknown };

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar' } } });
    calls = [];
    respond = (call) => ({
      body: { success: true, data: { files: [{ path: `~/.claude/commands/${(call.body as { abbr: string }).abbr}.md`, action: call.method === 'DELETE' ? 'removed' : 'created' }] } },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const r = respond(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const box = () => screen.getByRole('checkbox', { name: /Also work inside Claude Code/ });

  it('offers it only once there is an abbreviation', () => {
    useSkillNotesStore.setState({ notes: {} });
    render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names the CLI and the way to type it, for each agent', () => {
    const { unmount } = render(<SkillNotes resource={res()} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Claude Code (/rar)' })).toBeTruthy();
    unmount();
    useSkillNotesStore.setState({ notes: { 'codex:x': { fav: false, tags: [], abbr: 'rar' } } });
    const codex = render(<SkillNotes resource={res({ agent: 'codex', name: 'x' })} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Codex ($rar)' })).toBeTruthy();
    codex.unmount();
    useSkillNotesStore.setState({ notes: { 'shared:x': { fav: false, tags: [], abbr: 'rar' } } });
    render(<SkillNotes resource={res({ agent: 'shared', name: 'x' })} realNames={REAL} />);
    expect(screen.getByRole('checkbox', { name: 'Also work inside Claude Code and Codex (/rar, $rar)' })).toBeTruthy();
  });

  it('creates the command on tick, lists the files, and remembers it', async () => {
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    expect(calls).toEqual([{
      url: '/api/resources/aliases', method: 'POST',
      body: { agent: 'claude', kind: 'skill', target: 'retouch-ascii-review', abbr: 'rar' },
    }]);
    expect(await screen.findByText('~/.claude/commands/rar.md')).toBeTruthy();
    expect(notes()['claude:retouch-ascii-review'].cli).toBe(true);
    expect(box()).toBeChecked();
  });

  it('shows the server\'s reason and stays unticked when it refuses', async () => {
    respond = () => ({ status: 409, body: { success: false, error: '~/.claude/commands/rar.md already exists and was not made by AASC; it was left alone.' } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    expect((await screen.findByRole('alert')).textContent).toContain('was not made by AASC');
    expect(box()).not.toBeChecked();
    expect(notes()['claude:retouch-ascii-review'].cli).toBeUndefined();
  });

  it('removes the command on untick', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(box());
    await screen.findByText(/Removed/);
    expect(calls).toEqual([{ url: '/api/resources/aliases', method: 'DELETE', body: { agent: 'claude', kind: 'skill', abbr: 'rar' } }]);
    expect(notes()['claude:retouch-ascii-review'].cli).toBeUndefined();
  });

  it('moves the command when the abbreviation changes: new first, then the old one goes', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Abbreviation');
    await user.clear(input);
    await user.type(input, 'rv');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    await screen.findByText('~/.claude/commands/rv.md');
    expect(calls.map((c) => [c.method, (c.body as { abbr: string }).abbr])).toEqual([['POST', 'rv'], ['DELETE', 'rar']]);
    expect(notes()['claude:retouch-ascii-review']).toMatchObject({ abbr: 'rv', cli: true });
  });

  it('keeps the old abbreviation and command when the new one cannot be created', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    respond = () => ({ status: 409, body: { success: false, error: 'nope' } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    const input = screen.getByLabelText('Abbreviation');
    await user.clear(input);
    await user.type(input, 'rv');
    await user.click(screen.getByRole('button', { name: 'Save abbreviation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('nope');
    expect(notes()['claude:retouch-ascii-review']).toMatchObject({ abbr: 'rar', cli: true });
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('removes the command before clearing the abbreviation', async () => {
    useSkillNotesStore.setState({ notes: { 'claude:retouch-ascii-review': { fav: false, tags: [], abbr: 'rar', cli: true } } });
    const user = userEvent.setup();
    render(<SkillNotes resource={res()} realNames={REAL} />);
    await user.click(screen.getByRole('button', { name: 'Clear abbreviation' }));
    await waitFor(() => expect(notes()).toEqual({}));
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
  });
});
