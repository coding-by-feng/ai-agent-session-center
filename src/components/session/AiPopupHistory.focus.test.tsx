// AiPopupHistory.focus.test.tsx — a saved highlight clicked in PROJECT opens its record here on Lite, which has no REVIEW.
// The record may have come from another session, whose popups this list wouldn't otherwise show.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const log = vi.hoisted(() => ({ list: vi.fn(), find: vi.fn() }));
vi.mock('@/lib/translationLog', () => ({
  listByOriginSession: log.list,
  findByUuid: log.find,
  setArchived: vi.fn(),
  setNotes: vi.fn(),
  setFavorite: vi.fn(),
  setAlias: vi.fn(),
  deleteLog: vi.fn(),
}));
vi.mock('./PopupResponse', () => ({ default: () => <div data-testid="response" /> }));

import AiPopupHistory from './AiPopupHistory';
import { useUiStore } from '@/stores/uiStore';
import type { DbTranslationLog } from '@/lib/db';

const record = (uuid: string, selection: string): DbTranslationLog => ({
  uuid, selection, mode: 'explain-native', createdAt: 1_000, updatedAt: 1_000, favorite: 1, archived: 0,
  alias: '', notes: '', originSessionId: 's1',
} as unknown as DbTranslationLog);

describe('AiPopupHistory opening a saved highlight', () => {
  let scrolled: Mock<() => void>;

  beforeEach(() => {
    log.list.mockReset();
    log.find.mockReset();
    log.list.mockResolvedValue([record('mine', 'my selection')]);
    log.find.mockImplementation(async (uuid: string) => (uuid === 'theirs' ? record('theirs', 'their selection') : record(uuid, 'my selection')));
    useUiStore.setState({ focusedAiPopup: null });
    scrolled = vi.fn<() => void>();
    Element.prototype.scrollIntoView = scrolled;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('expands the record when it came from this session', async () => {
    render(<AiPopupHistory sessionId="s1" />);
    await screen.findByText(/my selection/);
    expect(screen.queryByTestId('response')).not.toBeInTheDocument();

    act(() => useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'mine' }));

    expect(await screen.findByTestId('response')).toBeInTheDocument();
    expect(screen.getAllByText(/my selection/).length).toBeGreaterThan(0);
  });

  it('adds and expands a record from another session', async () => {
    useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'theirs' });
    render(<AiPopupHistory sessionId="s1" />);
    expect((await screen.findAllByText(/their selection/)).length).toBeGreaterThan(0);
    expect(await screen.findByTestId('response')).toBeInTheDocument();
    expect(screen.getByText(/my selection/)).toBeInTheDocument();
  });

  it('ignores a click made in another session', async () => {
    useUiStore.getState().setFocusedAiPopup({ sessionId: 's2', uuid: 'theirs' });
    render(<AiPopupHistory sessionId="s1" />);
    await screen.findByText(/my selection/);
    expect(screen.queryByText(/their selection/)).not.toBeInTheDocument();
    expect(log.find).not.toHaveBeenCalled();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('opens the record once: coming back to the tab leaves the list as it was', async () => {
    useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'theirs' });
    const first = render(<AiPopupHistory sessionId="s1" />);
    expect(await screen.findByTestId('response')).toBeInTheDocument();
    expect(scrolled).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<AiPopupHistory sessionId="s1" />);
    expect((await screen.findAllByText(/their selection/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('response')).not.toBeInTheDocument();
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it('stays closed once closed by hand, whatever reloads the list', async () => {
    useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'mine' });
    render(<AiPopupHistory sessionId="s1" />);
    await screen.findByTestId('response');

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByTestId('response')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { pressed: true }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('response')).not.toBeInTheDocument();
  });

  it('opens and scrolls again each time the same highlight is clicked', async () => {
    render(<AiPopupHistory sessionId="s1" />);
    await screen.findByText(/my selection/);
    act(() => useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'mine' }));
    await screen.findByTestId('response');
    fireEvent.click(screen.getByRole('button', { expanded: true }));

    act(() => useUiStore.getState().setFocusedAiPopup({ sessionId: 's1', uuid: 'mine' }));

    expect(await screen.findByTestId('response')).toBeInTheDocument();
    expect(scrolled).toHaveBeenCalledTimes(2);
  });
});
