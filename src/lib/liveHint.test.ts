// liveHint.test.ts — the one-time tip on the LIVE page ("Open a session: click
// a card, or LIVE"). LIVE is already the active tab when the app opens, so a
// highlighted tab reads as "you are here"; the tip is about OPENING a session.
import { describe, it, expect } from 'vitest';
import {
  CARET_MIN,
  LIVE_HINT_STORAGE_KEY,
  placeLiveHint,
  shouldShowLiveHint,
  type LiveHintInputs,
} from './liveHint';

const eligible: LiveHintInputs = {
  dismissed: false,
  onLiveRoute: true,
  scene3dEnabled: false,
  isMobile: false,
  boardShown: true,
  panelOpen: false,
};

describe('shouldShowLiveHint', () => {
  it('shows on the desktop LIVE board, with no session panel open, until dismissed', () => {
    expect(shouldShowLiveHint(eligible)).toBe(true);
  });

  it.each<[string, Partial<LiveHintInputs>]>([
    ['once dismissed (it is a one-time tip)', { dismissed: true }],
    ['on another tab', { onLiveRoute: false }],
    ['with the 3D scene on, where there is no board', { scene3dEnabled: true }],
    ['on a phone, where the agent list is the page', { isMobile: true }],
    ['while there is no board: loading, or no sessions yet', { boardShown: false }],
    ['while a session panel covers the page', { panelOpen: true }],
  ])('hides %s', (_why, over) => {
    expect(shouldShowLiveHint({ ...eligible, ...over })).toBe(false);
  });

  it('remembers the dismissal under one key', () => {
    expect(LIVE_HINT_STORAGE_KEY).toBe('live-hint-dismissed');
  });
});

describe('placeLiveHint — the bubble points at the LIVE tab and stays inside the board', () => {
  // Viewport coordinates in, board-relative out: the board's content box starts
  // at `containerLeft`, the tab's centre is at `anchorCenter`.
  const base = { anchorCenter: 190, containerLeft: 24, containerWidth: 1100, bubbleWidth: 320 };

  it('puts the caret under the middle of the tab', () => {
    const p = placeLiveHint(base);
    expect(base.containerLeft + p.left + p.caretX).toBe(base.anchorCenter);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });

  it('never starts left of the board', () => {
    const p = placeLiveHint({ ...base, anchorCenter: 30 });
    expect(p.left).toBe(0);
    expect(p.caretX).toBeGreaterThanOrEqual(CARET_MIN);
  });

  it('never runs past the right edge of the board', () => {
    const p = placeLiveHint({ ...base, anchorCenter: 1110 });
    expect(p.left + base.bubbleWidth).toBe(base.containerWidth);
  });

  it('keeps the caret on the bubble when the tab is off to one side', () => {
    expect(placeLiveHint({ ...base, anchorCenter: 5000 }).caretX).toBe(base.bubbleWidth - CARET_MIN);
    expect(placeLiveHint({ ...base, anchorCenter: -400 }).caretX).toBe(CARET_MIN);
  });

  it('pins a bubble wider than the board to its left edge', () => {
    const p = placeLiveHint({ ...base, containerWidth: 200 });
    expect(p.left).toBe(0);
  });

  it('returns whole pixels', () => {
    const p = placeLiveHint({ ...base, anchorCenter: 190.6, containerLeft: 24.2 });
    expect(Number.isInteger(p.left)).toBe(true);
    expect(Number.isInteger(p.caretX)).toBe(true);
  });
});
