// src/components/ui/AutocompleteTextarea.test.tsx — the `$` skill menu.
//
// Codex addresses skills as `$skill-name`; `/skill-name` is inert there. That
// makes the sigil-per-CLI routing the whole feature, and it is invisible in a
// diff: the dropdown, CSS and positioning are shared with the `/` and `@`
// menus, so only behavior can be asserted.
//
// Three rules are pinned:
//   1. `$` on a Codex session lists skills, inserted WITH the `$`.
//   2. `$` on a Claude session opens nothing — prompts are full of `$HOME`,
//      `$1`, `$5.00`, and a dropdown on each would be noise.
//   3. `/` on a Codex session lists prompts only, never skills.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutocompleteTextarea from './AutocompleteTextarea';
import type { CommandEntry } from '@/lib/commandIndex';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

/** Rendered only inside the dropdown — a reliable "menu is open" probe. */
const DROPDOWN_FOOTER = '↑↓ navigate · Enter select · Esc close';

const CODEX_ENTRIES: CommandEntry[] = [
  { name: 'compact', description: 'Compact history', cli: 'codex', kind: 'command', source: 'builtin' },
  { name: 'bilingual-md', description: 'EN + CN', cli: 'codex', kind: 'command', source: 'global' },
  { name: 'retouch-current-prompt', description: 'Retouch the prompt', cli: 'codex', kind: 'skill', source: 'global' },
  { name: 'ascii-review-first', description: 'ASCII first', cli: 'codex', kind: 'skill', source: 'global' },
  { name: 'imagegen', description: 'Generate images', cli: 'codex', kind: 'skill', source: 'builtin' },
];

const CLAUDE_ENTRIES: CommandEntry[] = [
  { name: 'clear', description: 'Clear history', cli: 'claude', kind: 'command', source: 'builtin' },
  { name: 'todo', description: 'Manage todos', cli: 'claude', kind: 'skill', source: 'global' },
];

const fetchCommandIndex = vi.fn();
vi.mock('@/lib/commandIndex', async () => {
  const actual = await vi.importActual<typeof import('@/lib/commandIndex')>('@/lib/commandIndex');
  return { ...actual, fetchCommandIndex: (...a: unknown[]) => fetchCommandIndex(...a) };
});

function seedSession(id: string, startupCommand: string): void {
  const session = { sessionId: id, startupCommand } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([[id, session]]) });
}

/** Render a controlled textarea that keeps its own value, like the real parents. */
function Harness({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState('');
  return (
    <AutocompleteTextarea
      value={value}
      onChange={setValue}
      sessionId={sessionId}
      ariaLabel="prompt"
    />
  );
}

beforeEach(() => {
  fetchCommandIndex.mockReset();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: new Map() });
});

describe('AutocompleteTextarea — $ skill trigger', () => {
  it('lists Codex skills on `$` and inserts them WITH the $ sigil', async () => {
    fetchCommandIndex.mockResolvedValue(CODEX_ENTRIES);
    seedSession('s-codex', 'codex');
    const user = userEvent.setup();
    render(<Harness sessionId="s-codex" />);

    await user.click(screen.getByLabelText('prompt'));
    await user.keyboard('$reto');

    const row = await screen.findByText('$retouch-current-prompt');
    expect(row).toBeTruthy();
    // The `/` sigil must never appear on a Codex skill row.
    expect(screen.queryByText('/retouch-current-prompt')).toBeNull();

    await user.click(row);
    await waitFor(() =>
      expect((screen.getByLabelText('prompt') as HTMLTextAreaElement).value).toBe(
        '$retouch-current-prompt ',
      ),
    );
  });

  it('offers preinstalled .system skills alongside user skills', async () => {
    fetchCommandIndex.mockResolvedValue(CODEX_ENTRIES);
    seedSession('s-codex', 'codex');
    const user = userEvent.setup();
    render(<Harness sessionId="s-codex" />);

    await user.click(screen.getByLabelText('prompt'));
    await user.keyboard('$');

    expect(await screen.findByText('$imagegen')).toBeTruthy();
    expect(screen.getByText('$ascii-review-first')).toBeTruthy();
    // ...and never a command, which `/` owns.
    expect(screen.queryByText('$compact')).toBeNull();
    expect(screen.queryByText('/compact')).toBeNull();
  });

  it('does NOT open a menu on `$` for a Claude session', async () => {
    fetchCommandIndex.mockResolvedValue(CLAUDE_ENTRIES);
    seedSession('s-claude', 'claude');
    const user = userEvent.setup();
    render(<Harness sessionId="s-claude" />);

    await user.click(screen.getByLabelText('prompt'));
    await user.keyboard('$todo');

    // Give any in-flight async menu build a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 20));
    // The footer only exists inside the dropdown, so it is the unambiguous
    // "is the menu open" probe — `$todo` alone also matches the textarea's
    // own text content.
    expect(screen.queryByText(DROPDOWN_FOOTER)).toBeNull();
    expect(fetchCommandIndex).not.toHaveBeenCalled();
  });

  it('`/` on Codex lists prompts and builtins but NOT skills', async () => {
    fetchCommandIndex.mockResolvedValue(CODEX_ENTRIES);
    seedSession('s-codex', 'codex');
    const user = userEvent.setup();
    render(<Harness sessionId="s-codex" />);

    await user.click(screen.getByLabelText('prompt'));
    await user.keyboard('/');

    expect(await screen.findByText('/compact')).toBeTruthy();
    expect(screen.getByText('/bilingual-md')).toBeTruthy();
    expect(screen.queryByText('/retouch-current-prompt')).toBeNull();
    expect(screen.queryByText('$retouch-current-prompt')).toBeNull();
  });

  it('`/` on Claude still lists commands AND skills together', async () => {
    fetchCommandIndex.mockResolvedValue(CLAUDE_ENTRIES);
    seedSession('s-claude', 'claude');
    const user = userEvent.setup();
    render(<Harness sessionId="s-claude" />);

    await user.click(screen.getByLabelText('prompt'));
    await user.keyboard('/');

    expect(await screen.findByText('/clear')).toBeTruthy();
    expect(screen.getByText('/todo')).toBeTruthy();
  });
});
