// PromptTokens.test.tsx — a queued prompt's skills and commands drawn as tokens (Oct 21 2026):
// only words that ARE this CLI's commands or skills (the Mac's /api/commands), so a web route
// like "/checkout" in a prompt stays text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import PromptTokens, { PromptSkillChips } from './PromptTokens';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const ENTRIES = {
  claude: [
    { name: 'raab', kind: 'skill', source: 'global', cli: 'claude', description: '' },
    { name: 'simplify', kind: 'command', source: 'builtin', cli: 'claude', description: '' },
    { name: 'krt-work', kind: 'skill', source: 'global', cli: 'claude', description: '' },
  ],
  codex: [
    { name: 'krt-work', kind: 'skill', source: 'global', cli: 'codex', description: '' },
    { name: 'review', kind: 'command', source: 'builtin', cli: 'codex', description: '' },
  ],
};

let project = 0;
const session = (id: string, cliSource: string) =>
  ({ sessionId: id, cliSource, status: 'idle', projectPath: `/tok/${++project}` }) as unknown as Session;

beforeEach(() => {
  useSessionStore.setState({ sessions: new Map([['c', session('c', 'claude')], ['x', session('x', 'codex')]]) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify({ entries: url.includes('cli=codex') ? ENTRIES.codex : ENTRIES.claude }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const marked = (el: HTMLElement) => [...el.querySelectorAll('[data-prompt-token]')].map((n) => n.textContent);

describe('PromptTokens', () => {
  it('wraps each of this CLI’s skills and commands in a token, and keeps the text whole', async () => {
    const { container } = render(<PromptTokens text="view the details of it /raab, then /simplify" sessionId="c" />);
    await waitFor(() => expect(marked(container)).toEqual(['/raab', '/simplify']));
    expect(container.textContent).toBe('view the details of it /raab, then /simplify');
  });

  it('leaves a word that only looks like one plain: a web route is not a skill', async () => {
    const { container } = render(<PromptTokens text="Check the score of /checkout, then /raab" sessionId="c" />);
    await waitFor(() => expect(marked(container)).toEqual(['/raab']));
  });

  it('uses the row’s own CLI: a Codex session’s $skill is a token, a Claude one is text', async () => {
    const codex = render(<PromptTokens text="run $krt-work then /review" sessionId="x" />).container;
    await waitFor(() => expect(marked(codex)).toEqual(['$krt-work', '/review']));
    const claude = render(<PromptTokens text="run $krt-work then /krt-work" sessionId="c" />).container;
    await waitFor(() => expect(marked(claude)).toEqual(['/krt-work']));
  });

  it('asks the Mac nothing for a prompt with no candidate, and stays plain if the list can’t load', async () => {
    render(<PromptTokens text="just words, no commands" sessionId="c" />);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { container } = render(<PromptTokens text="try /raab" sessionId="c" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(marked(container)).toEqual([]);
    expect(container.textContent).toBe('try /raab');
  });
});

describe('PromptSkillChips', () => {
  const chips = (el: HTMLElement) => [...el.querySelectorAll('[data-prompt-chip]')].map((n) => n.textContent);

  it('pulls each of this CLI’s skills and commands out of the prompt, once each, in order', async () => {
    const { container } = render(<PromptSkillChips text="fix it /simplify then /raab and /raab again, not /checkout" sessionId="c" />);
    await waitFor(() => expect(chips(container)).toEqual(['/simplify', '/raab']));
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws nothing for a prompt with no skill', async () => {
    const { container } = render(<PromptSkillChips text="just words, and /tmp/a.png" sessionId="c" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });
});

