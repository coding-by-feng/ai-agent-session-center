// UsageSheet.test.tsx — the Usage sheet's Context window card opens to its details (Oct 21 2026):
// free space, the last reply's tokens by kind and how old the reading is.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Session } from '@/types';
import type { ContextBreakdown } from '@/types/chat';
import UsageSheet from './UsageSheet';

const api = vi.hoisted(() => ({ fetchContextBreakdown: vi.fn() }));
vi.mock('@/lib/chat/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/chatApi')>()),
  fetchContextBreakdown: api.fetchContextBreakdown,
}));

beforeEach(() => {
  api.fetchContextBreakdown.mockReset();
  api.fetchContextBreakdown.mockResolvedValue({ ok: true, data: null });
});

const NOW = Date.now();

function session(context: Record<string, unknown> | undefined): Session {
  return {
    sessionId: 's1', status: 'working', cliSource: 'claude', model: 'claude-opus-5-5',
    runtime: context ? { context, contextAt: NOW - 3 * 60_000 } : undefined,
  } as unknown as Session;
}

describe('UsageSheet — the Context window card', () => {
  it('opens to what the window holds, and closes again', () => {
    render(<UsageSheet open onClose={() => {}} session={session({
      pct: 25, size: 1_000_000, tokens: 247_000, parts: { cacheRead: 240_000, cacheWrite: 6_500, input: 500, output: 2_100 },
    })} />);
    const card = screen.getByRole('button', { name: /^Context window/ });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Read from cache')).toBeNull();

    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Context window details' });
    expect(within(details).getByText('753k free')).toBeInTheDocument();
    const rows = within(details).getAllByRole('term').map((t) => `${t.textContent} ${t.nextElementSibling?.textContent}`);
    expect(api.fetchContextBreakdown).toHaveBeenCalledWith('s1', expect.anything());
    expect(rows).toEqual(['Read from cache 240k', 'Newly cached 6.5k', 'New input 500', 'Last reply’s output 2.1k']);
    expect(within(details).getByText('Reported 3m ago')).toBeInTheDocument();

    fireEvent.click(card);
    expect(screen.queryByRole('region', { name: 'Context window details' })).toBeNull();
  });

  it('is a plain card, not a button, when only the % is known', () => {
    render(<UsageSheet open onClose={() => {}} session={session({ pct: 9 })} />);
    expect(screen.getByText('Context window')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Context window/ })).toBeNull();
  });

  it('shows what fills the window by type, with its share, and the largest items', async () => {
    const breakdown: ContextBreakdown = {
      tokens: 300_000,
      kinds: [
        { kind: 'bash', tokens: 120_000 },
        { kind: 'memory', tokens: 26_000 },
        { kind: 'tools', tokens: 20_000 },
        { kind: 'prompts', tokens: 200 },
        { kind: 'edits', tokens: 1_000 },
        { kind: 'system', tokens: 132_800 },
      ].sort((a, b) => b.tokens - a.tokens) as ContextBreakdown['kinds'],
      items: [{ kind: 'read', label: 'Read · server/index.ts', tokens: 38_000 }],
      requests: 85,
      sinceCompaction: true,
      measuredAt: NOW - 2 * 60_000,
    };
    api.fetchContextBreakdown.mockResolvedValue({ ok: true, data: breakdown });
    render(<UsageSheet open onClose={() => {}} session={session({
      pct: 30, size: 1_000_000, tokens: 300_000, parts: { cacheRead: 299_000, cacheWrite: 900, input: 100, output: 2_000 },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }));

    const kinds = await screen.findByRole('list', { name: 'What fills the context window' });
    const rows = within(kinds).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      'System prompt & setup133k · 13%',
      'Bash output120k · 12%',
      'Memory (CLAUDE.md, rules)26k · 3%',
      'Tool definitions20k · 2%',
      'Other (2 kinds)1.2k · <1%',
      'Free700k · 70%',
    ]);
    const items = screen.getByLabelText('Largest items in the context window');
    expect(within(items).getByText('Read · server/index.ts')).toBeInTheDocument();
    expect(screen.getByText(/Measured from 85 requests since the last compaction, 2m ago/)).toBeInTheDocument();
    expect(screen.getByText('Last reply, as reported')).toBeInTheDocument();
  });

  it('says a Codex session’s window is not measured', async () => {
    render(<UsageSheet open onClose={() => {}} session={session({ pct: 30, size: 200_000, tokens: 60_000 })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Context window/ }));
    expect(await screen.findByText('What fills the window is measured for Claude Code sessions only.')).toBeInTheDocument();
  });
});
