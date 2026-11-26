// ContextDetailsPopover.test.tsx — the header chip's Context details card in sections (Nov 27 2026):
// WINDOW (with free space), WHAT'S IN IT (the breakdown, each kind opening to its entries), TOKENS,
// COST, SESSION; each server read with its own loading / failed line; placed inside the viewport.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ContextDetailsPopover from './ContextDetailsPopover';
import { placeCard } from '@/lib/contextDetails';
import type { Session } from '@/types';
import type { ContextBreakdown } from '@/types/chat';

const SESSION = {
  sessionId: '1761a9e8-aaaa-bbbb-cccc-000000000000',
  model: 'claude-opus-5-5',
  runtime: {
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    effortAt: 1,
    contextAt: 1,
    context: { pct: 19, size: 1_000_000, tokens: 187_157, parts: { input: 1000, cacheWrite: 2000, cacheRead: 184_157, output: 900 } },
  },
} as unknown as Session;

const BREAKDOWN: ContextBreakdown = {
  tokens: 187_157,
  kinds: [
    { kind: 'read', tokens: 61_000, items: [{ kind: 'read', label: 'Read · server/apiRouter.ts', tokens: 18_000 }], rest: { count: 12, tokens: 43_000 } },
    { kind: 'tools', tokens: 38_000 },
    { kind: 'replies', tokens: 29_000, items: [{ kind: 'replies', label: 'Reply · Done.', tokens: 4_100, count: 3 }] },
  ],
  items: [{ kind: 'read', label: 'Read · server/apiRouter.ts', tokens: 18_000 }],
  requests: 42,
  sinceCompaction: true,
  measuredAt: Date.now(),
};

const USAGE = { totals: { steps: 42, input: 100_000, cacheWrite: 400_000, cacheRead: 8_600_000, output: 96_000 }, costUsd: 4.12, terminal: { cols: 180, rows: 48 } };

function answer(data: unknown, status = 200) {
  return Promise.resolve({ ok: status === 200, status, json: async () => ({ success: status === 200, data }) });
}

function renderCard(routes: { breakdown?: () => Promise<unknown>; usage?: () => Promise<unknown> } = {}) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('context-breakdown')) return (routes.breakdown ?? (() => answer(BREAKDOWN)))();
    return (routes.usage ?? (() => answer(USAGE)))();
  }));
  const anchorRef = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={anchorRef} type="button">chip</button>
      <ContextDetailsPopover session={SESSION} anchorRef={anchorRef} id="card" onClose={() => {}} />
    </>,
  );
  return screen.getByRole('dialog', { name: 'Context details' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ContextDetailsPopover', () => {
  it('shows its sections in order, with the effort and the free space', async () => {
    const card = renderCard();
    await screen.findByRole('list', { name: 'What fills the context window' });
    const headings = within(card).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Window', 'What’s in it', 'Tokens', 'Cost', 'Session']);
    expect(card.textContent).toContain('Opus 5.5 · xhigh');
    expect(card.textContent).toContain('813k free');
    expect(await within(card).findByText('$4.12')).toBeTruthy();
    expect(within(card).getByRole('rowheader', { name: 'Session' })).toBeTruthy();
  });

  it('opens a kind to its largest entries, from the keyboard too', async () => {
    renderCard();
    const reads = await screen.findByRole('button', { name: /File reads/ });
    expect(reads.getAttribute('aria-expanded')).toBe('false');
    reads.focus();
    fireEvent.click(reads);
    expect(reads.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'In File reads' });
    expect(list.textContent).toContain('12 more');
    // One kind open at a time.
    fireEvent.click(screen.getByRole('button', { name: /Claude’s replies/ }));
    expect(screen.queryByRole('list', { name: 'In File reads' })).toBeNull();
    expect(screen.getByRole('list', { name: 'In Claude’s replies' }).textContent).toContain('×3');
  });

  it('gives each kind its share of what is in the window, with no Free row', async () => {
    renderCard();
    const kinds = await screen.findByRole('list', { name: 'What fills the context window' });
    expect(within(kinds).queryByText('Free')).toBeNull();
    // 61k of the 187k in it, not 6% of the 1M window.
    expect(within(kinds).getByRole('button', { name: /File reads/ }).textContent).toContain('33%');
  });

  it('says when there is nothing to measure yet, and keeps the rest of the card', async () => {
    const card = renderCard({ breakdown: () => answer(null) });
    expect(await within(card).findByText(/Nothing to measure yet/)).toBeTruthy();
    expect(await within(card).findByText('$4.12')).toBeTruthy();
  });

  it('gives each read its own failed line', async () => {
    const card = renderCard({ breakdown: () => answer(null, 500) });
    expect(await within(card).findByText('Couldn’t read what fills the window.')).toBeTruthy();
    expect(await within(card).findByText('$4.12')).toBeTruthy();
  });
});

describe('placeCard', () => {
  const viewport = { width: 1200, height: 800 };
  const card = (naturalHeight: number) => ({ width: 360, naturalHeight });

  it('goes below the chip when it fits, above when only that fits', () => {
    expect(placeCard({ top: 40, bottom: 60, left: 100 }, card(300), viewport)).toEqual({ top: 66, left: 100, maxHeight: 726 });
    expect(placeCard({ top: 700, bottom: 720, left: 100 }, card(300), viewport)).toMatchObject({ top: 394 });
  });

  it('takes the larger side and caps the height when it fits neither way', () => {
    const below = placeCard({ top: 200, bottom: 220, left: 100 }, card(900), viewport);
    expect(below).toEqual({ top: 226, left: 100, maxHeight: 566 });
    const above = placeCard({ top: 600, bottom: 620, left: 100 }, card(900), viewport);
    expect(above).toEqual({ top: 8, left: 100, maxHeight: 586 });
  });

  it('stays inside the right edge', () => {
    expect(placeCard({ top: 40, bottom: 60, left: 1100 }, card(300), viewport).left).toBe(832);
  });
});
