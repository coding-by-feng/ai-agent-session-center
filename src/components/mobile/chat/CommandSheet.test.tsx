// CommandSheet — the phone's `/` sheet ranks by use (Oct 24 2026): with nothing typed a "Most used"
// section leads (commands and skills together), every group below is ordered by uses, and a used
// row says how often. A count the Mac didn't send is never shown as zero.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { CommandEntry } from '@/lib/commandIndex';
import CommandSheet from './CommandSheet';

const index = vi.hoisted(() => ({ entries: [] as CommandEntry[] }));

vi.mock('@/lib/commandIndex', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/commandIndex')>();
  return { ...mod, fetchCommandIndex: vi.fn(async () => index.entries) };
});

const entry = (name: string, over: Partial<CommandEntry> = {}): CommandEntry => ({
  name, description: `About ${name}`, cli: 'claude', kind: 'command', source: 'builtin', ...over,
});

const COUNTED: CommandEntry[] = [
  entry('add-dir'),
  entry('advisor'),
  entry('clear', { uses: 31 }),
  entry('raab', { source: 'global', uses: 105 }),
  entry('rar', { source: 'global', uses: 1 }),
  entry('brainstorming', { kind: 'skill', source: 'global', uses: 48 }),
  entry('plan', { kind: 'skill', source: 'global' }),
];

function renderSheet() {
  render(<CommandSheet open onClose={() => {}} cli="claude" projectPath="/p" onPick={() => {}} />);
}

const section = (name: string) => screen.getByRole('region', { name });
/** Each row's token, from its accessible name ("/clear: About clear"). */
const rowTokens = (region: HTMLElement) => within(region).getAllByRole('button').map((b) => b.getAttribute('aria-label')?.split(': ')[0]);

beforeEach(() => {
  index.entries = COUNTED;
});

describe('CommandSheet — ranked by use', () => {
  it('leads with the most used, commands and skills together', async () => {
    renderSheet();
    const top = await screen.findByRole('region', { name: 'Most used' });
    expect(rowTokens(top)).toEqual(['/raab', '/brainstorming', '/clear', '/rar']);
    expect(screen.getAllByRole('region')[0]).toBe(top);
  });

  it('orders every group below by uses, then A–Z', async () => {
    renderSheet();
    await screen.findByRole('region', { name: 'Most used' });
    expect(rowTokens(section('Commands · Built-in'))).toEqual(['/clear', '/add-dir', '/advisor']);
    expect(rowTokens(section('Commands · Global'))).toEqual(['/raab', '/rar']);
    expect(rowTokens(section('Skills · Global'))).toEqual(['/brainstorming', '/plan']);
  });

  it('says how often a used row was used, and nothing on an unused one', async () => {
    renderSheet();
    const builtIn = await screen.findByRole('region', { name: 'Commands · Built-in' });
    expect(within(builtIn).getByRole('button', { name: /^\/clear/ })).toHaveTextContent('31 uses');
    expect(within(builtIn).getByRole('button', { name: /^\/add-dir/ })).not.toHaveTextContent(/use/);
    expect(within(section('Commands · Global')).getByRole('button', { name: /^\/rar/ })).toHaveTextContent('1 use');
  });

  it('drops the section while searching: the groups rank the matches', async () => {
    renderSheet();
    await screen.findByRole('region', { name: 'Most used' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search commands and skills' }), { target: { value: 'r' } });
    expect(screen.queryByRole('region', { name: 'Most used' })).toBeNull();
    expect(rowTokens(section('Commands · Global'))).toEqual(['/raab', '/rar']);
  });

  it('is the plain A–Z list when the Mac sent no counts', async () => {
    index.entries = COUNTED.map((e) => ({ ...e, uses: undefined }));
    renderSheet();
    const builtIn = await screen.findByRole('region', { name: 'Commands · Built-in' });
    expect(screen.queryByRole('region', { name: 'Most used' })).toBeNull();
    expect(rowTokens(builtIn)).toEqual(['/add-dir', '/advisor', '/clear']);
    expect(builtIn).not.toHaveTextContent(/\buses?\b/);
  });
});
