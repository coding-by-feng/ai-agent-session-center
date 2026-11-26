import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SessionRuntimeChip from './SessionRuntimeChip';
import type { Session } from '@/types';

const session = (p: Partial<Session> = {}): Session =>
  ({ sessionId: 's', model: 'claude-opus-5-5', cliSource: 'claude', ...p }) as unknown as Session;

describe('SessionRuntimeChip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the current model and effort, and says both aloud', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1 } })} />);
    const chip = screen.getByRole('button', { name: 'Model Opus 5.5, effort high. Context details' });
    expect(chip.textContent).toContain('Opus 5.5');
    expect(chip.textContent).toContain('high');
  });

  it('follows a change: re-rendered with a new runtime it shows the new values', () => {
    const { rerender } = render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1 } })} />);
    rerender(<SessionRuntimeChip session={session({ runtime: { model: 'Haiku 4.5', modelAt: 2, effort: 'low', effortAt: 2 } })} />);
    expect(screen.getByRole('button', { name: 'Model Haiku 4.5, effort low. Context details' })).toBeTruthy();
  });

  it('drops the effort half while the effort is unknown', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Haiku 4.5', modelAt: 2, effortAt: 2 } })} />);
    const chip = screen.getByRole('button', { name: 'Model Haiku 4.5. Context details' });
    expect(chip.querySelector('[data-part="effort"]')).toBeNull();
  });

  it('marks a launch-time value as not yet confirmed by the CLI', () => {
    render(<SessionRuntimeChip session={session({ effortLevel: 'max' })} />);
    expect(screen.getByRole('button').getAttribute('data-live')).toBe('false');
  });

  it('opens the Context details card on click, and closes it on Escape', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({
      success: true,
      data: { totals: { steps: 165, input: 1, cacheWrite: 0, cacheRead: 99, output: 284_000 }, costUsd: 14.1, terminal: { cols: 115, rows: 35 } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    render(<SessionRuntimeChip session={session({ sessionId: '1761a9e8-0000', runtime: {
      model: 'Opus 5.5', modelAt: 1, context: { pct: 26, size: 1_000_000, tokens: 263_000, parts: { cacheRead: 259_300, input: 3700, output: 128 } }, contextAt: 1,
    } })} />);
    const chip = screen.getByRole('button', { name: /Context details/ });
    expect(chip.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(chip);
    const card = await screen.findByRole('dialog', { name: 'Context details' });
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe(card.id);
    // The totals and the breakdown are read side by side (Nov 27 2026).
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/api/sessions/1761a9e8-0000/context-breakdown',
      '/api/sessions/1761a9e8-0000/context-usage',
    ]);
    await waitFor(() => expect(card.textContent).toContain('165 steps'));
    expect(card.textContent).toContain('263k / 1M (26.3%)');
    expect(card.textContent).toContain('$14.10');
    expect(card.textContent).toContain('Terminal 115×35');
    expect(card.textContent).toContain('#1761a9e8');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('says so when the totals cannot be read, and still shows the last reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    render(<SessionRuntimeChip session={session({ runtime: {
      model: 'Opus 5.5', modelAt: 1, context: { pct: 26, size: 1_000_000, tokens: 263_000, parts: { cacheRead: 259_300, input: 3700, output: 128 } }, contextAt: 1,
    } })} />);
    fireEvent.click(screen.getByRole('button', { name: /Context details/ }));
    const card = await screen.findByRole('dialog');
    await waitFor(() => expect(card.textContent).toContain('Couldn’t read the session totals.'));
    const reply = within(card).getByRole('rowheader', { name: 'Last reply' }).closest('tr');
    expect(reply?.textContent).toContain('263k');
    expect(reply?.textContent).toContain('128');
    expect(card.textContent).toContain('Couldn’t read what fills the window.');
    expect(card.textContent).not.toContain('steps');
  });

  it('closes on a press outside the card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }))));
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1 } })} />);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing for a Codex session', () => {
    const { container } = render(<SessionRuntimeChip session={session({ cliSource: 'codex', model: 'gpt-5-codex' })} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the context-window % as its own segment, banded, and says it aloud', () => {
    render(<SessionRuntimeChip session={session({ runtime: {
      model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1, context: { pct: 91, size: 200000, tokens: 182000 }, contextAt: 1,
    } })} />);
    const chip = screen.getByRole('button', { name: 'Model Opus 5.5, effort high, context 91% used. Context details' });
    const part = chip.querySelector('[data-part="context"]');
    expect(part?.textContent).toContain('91%');
    expect(part?.getAttribute('data-level')).toBe('high');
  });

  it('has no context segment until Claude Code reports one', () => {
    render(<SessionRuntimeChip session={session({ runtime: { model: 'Opus 5.5', modelAt: 1 } })} />);
    expect(screen.getByRole('button').querySelector('[data-part="context"]')).toBeNull();
  });
});
