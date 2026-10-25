// ResourcesView.usage.test.tsx — the Library's use counts (Oct 23 2026): each skill or command
// row ends in its uses over the last 90 days, those lists sort by them, the detail pane splits a
// count into typed and agent uses, and a rule says why it has none. The counts are extra: a
// failed read shows no count and no error. Fixture: src/__tests__/fixtures/resourceCatalog.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, within, fireEvent } from '@testing-library/react';
import { stubApi, urlsCalled, renderView, urlParams, ready, row, listRows, detail, LAZY } from '@/__tests__/fixtures/resourceCatalog';

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ResourcesView — use counts', () => {
  it('ends each skill row in its uses, and a dash when it was not used', async () => {
    renderView('/resources?type=skill');
    await ready();
    expect(await screen.findByText('17 uses', {}, LAZY)).toBeInTheDocument();
    expect(row(/^tdd Claude/)).toHaveTextContent('17 uses');
    expect(row(/^tdd Codex/)).toHaveTextContent('3 uses');
    expect(row(/^research/)).toHaveTextContent('40 uses');
    expect(row(/^old-skill/)).toHaveAccessibleName(/not used/);
    expect(within(row(/^tdd Claude/)).getByText('17 uses')).toHaveAttribute(
      'title', '17 uses in the last 90 days: 12 typed by you, 5 by the agent',
    );
  });

  it('gives a rule no count', async () => {
    renderView('/resources?type=rule');
    await ready();
    await screen.findByRole('list', { name: 'Resources' });
    for (const r of listRows()) expect(r).not.toHaveTextContent(/\buses?\b|not used/);
    expect(screen.queryByRole('combobox', { name: 'Sort' })).not.toBeInTheDocument();
  });

  it('sorts skills by use, most used first, and keeps the choice in the URL', async () => {
    renderView('/resources?type=skill');
    await ready();
    await screen.findByText('17 uses', {}, LAZY);
    const names = () => listRows().map((r) => r.textContent?.split(' ')[0]);
    expect(names().slice(0, 3)).toEqual(['app-helper', 'brand-voice', 'old-skill']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'uses' } });
    expect(urlParams().get('sort')).toBe('uses');
    expect(names().slice(0, 3)).toEqual(['research', 'tdd', 'tdd']);
    expect(row(/^research/)).toBe(listRows()[0]);
  });

  it('splits a count in the detail pane, with what it was counted by and its twin\'s count', async () => {
    renderView('/resources?id=sk-claude-tdd');
    await ready();
    const pane = detail();
    expect(await within(pane).findByText('Used 17× in the last 90 days', {}, LAZY)).toBeInTheDocument();
    expect(within(pane).getByText(/· 12 typed by you · 5 by the agent · last used 2h ago/)).toBeInTheDocument();
    expect(within(pane).getByText('Counted as /tdd')).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: 'Codex · Global · 3 uses' })).toBeInTheDocument();
  });

  it("says a Codex skill's count is typed uses only", async () => {
    renderView('/resources?id=sk-codex-tdd');
    await ready();
    expect(await within(detail()).findByText(/Counted as \$tdd · Codex keeps no record/, {}, LAZY)).toBeInTheDocument();
  });

  it('says an unused skill was not used, and why a rule has no count', async () => {
    renderView('/resources?id=sk-broken');
    await ready();
    expect(await within(detail()).findByText('Not used in the last 90 days', {}, LAZY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Rules \d+$/ }));
    fireEvent.click(row(/^coding-style\.md/));
    expect(within(detail()).getByText(/No use count: a rule loads into every session/)).toBeInTheDocument();
  });

  it('reads the counts again when the window comes back into focus, and keeps them when that read fails', async () => {
    const first = stubApi();
    renderView('/resources?type=skill');
    await ready();
    await screen.findByText('17 uses', {}, LAZY);
    const usageReads = (mock: ReturnType<typeof stubApi>) => urlsCalled(mock).filter((u) => u.endsWith('/usage')).length;
    expect(usageReads(first)).toBe(1);
    // Unknown is not zero: a failed read leaves the counts on screen.
    const failing = stubApi({ usage: 503 });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(usageReads(failing)).toBe(1);
    expect(row(/^tdd Claude/)).toHaveTextContent('17 uses');
  });

  it('shows no count and no error when the counts cannot be read', async () => {
    stubApi({ usage: 500 });
    renderView('/resources?type=skill&id=sk-claude-tdd');
    await ready();
    await within(detail()).findByRole('tab', { name: 'Preview' }, LAZY);
    expect(screen.queryByText(/\d+ uses?\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Used \d+×/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Resources are available only/)).not.toBeInTheDocument();
  });
});
