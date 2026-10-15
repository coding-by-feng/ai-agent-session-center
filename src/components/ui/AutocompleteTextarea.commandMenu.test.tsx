// AutocompleteTextarea.commandMenu.test.tsx — `commandMenu={false}` (AASC-20):
// on a phone the suggestion bar owns `/` and `$`, so no command dropdown opens,
// while `@` files still open their (portaled) dropdown. Default stays on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutocompleteTextarea from './AutocompleteTextarea';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const fetchCommandIndex = vi.fn(async () => [
  { name: 'clear', description: 'Clear history', cli: 'claude', kind: 'command', source: 'builtin' },
]);
vi.mock('@/lib/commandIndex', async () => {
  const actual = await vi.importActual<typeof import('@/lib/commandIndex')>('@/lib/commandIndex');
  return { ...actual, fetchCommandIndex: () => fetchCommandIndex() };
});

const FOOTER = '↑↓ navigate · Enter select · Esc close';

function Box({ commandMenu, onTextarea }: { commandMenu?: boolean; onTextarea?: (el: HTMLTextAreaElement | null) => void }) {
  const [value, setValue] = useState('');
  return (
    <AutocompleteTextarea
      value={value}
      onChange={setValue}
      sessionId="s1"
      projectPath="/p"
      ariaLabel="prompt"
      commandMenu={commandMenu}
      textareaRef={onTextarea}
    />
  );
}

beforeEach(() => {
  fetchCommandIndex.mockClear();
  useSessionStore.setState({ sessions: new Map([['s1', { sessionId: 's1', cliSource: 'claude' } as unknown as Session]]) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ path: '/src/a.ts', name: 'a.ts', type: 'file' }] }))));
});
afterEach(() => vi.unstubAllGlobals());

describe('AutocompleteTextarea commandMenu', () => {
  it('opens the command dropdown on `/` by default', async () => {
    render(<Box />);
    await userEvent.type(screen.getByLabelText('prompt'), '/cl');
    await waitFor(() => expect(screen.getByText(FOOTER)).toBeInTheDocument());
  });

  it('opens no command dropdown when off, but still the `@` file one', async () => {
    const onTextarea = vi.fn();
    render(<Box commandMenu={false} onTextarea={onTextarea} />);
    expect(onTextarea).toHaveBeenCalledWith(screen.getByLabelText('prompt'));
    await userEvent.type(screen.getByLabelText('prompt'), '/cl');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(FOOTER)).toBeNull();
    expect(fetchCommandIndex).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('prompt'), ' @a');
    await waitFor(() => expect(screen.getByText(FOOTER)).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });
});
