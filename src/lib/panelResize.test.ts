import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveQueueHeight,
  clampQueueHeight,
  loadQueueHeight,
  saveQueueHeight,
  DEFAULT_QUEUE_HEIGHT,
  MIN_QUEUE_HEIGHT,
  MIN_TERMINAL_HEIGHT,
} from './panelResize';

const TALL = 800; // roomy container: max = 800 - 160 = 640

describe('resolveQueueHeight — the inverted delta', () => {
  it('dragging the divider UP makes the queue TALLER', () => {
    // The divider is the queue's top edge. Negative dy = moved up.
    expect(resolveQueueHeight(250, -60, TALL)).toBe(310);
  });

  it('dragging the divider DOWN makes the queue SHORTER', () => {
    // The sign error this test exists for: `start + dy` would return 310 here
    // and the handle would appear to flee the pointer.
    expect(resolveQueueHeight(250, 60, TALL)).toBe(190);
  });

  it('a zero delta is a no-op', () => {
    expect(resolveQueueHeight(250, 0, TALL)).toBe(250);
  });
});

describe('clampQueueHeight', () => {
  it('enforces the minimum so the compose row cannot clip', () => {
    expect(clampQueueHeight(10, TALL)).toBe(MIN_QUEUE_HEIGHT);
  });

  it('enforces a maximum that reserves room for the terminal', () => {
    expect(clampQueueHeight(9999, TALL)).toBe(TALL - MIN_TERMINAL_HEIGHT);
  });

  it('leaves a height inside the range untouched', () => {
    expect(clampQueueHeight(300, TALL)).toBe(300);
  });

  it('lets the QUEUE yield when the container cannot fit both floors', () => {
    // A short window can't satisfy both; the terminal is the primary surface,
    // so the queue drops to its minimum rather than the terminal vanishing.
    const tiny = MIN_QUEUE_HEIGHT + 20;
    expect(clampQueueHeight(9999, tiny)).toBe(MIN_QUEUE_HEIGHT);
  });

  it('applies only the minimum when the container size is unknown', () => {
    // Container is 0 during first layout. Clamping against that would snap
    // the panel shut on every mount.
    expect(clampQueueHeight(400, 0)).toBe(400);
    expect(clampQueueHeight(10, 0)).toBe(MIN_QUEUE_HEIGHT);
  });

  it('falls back to the minimum for a non-finite height', () => {
    expect(clampQueueHeight(NaN, TALL)).toBe(MIN_QUEUE_HEIGHT);
  });
});

describe('loadQueueHeight / saveQueueHeight', () => {
  beforeEach(() => {
    localStorage.removeItem('queue-panel-height');
  });

  it('defaults when nothing is stored', () => {
    expect(loadQueueHeight()).toBe(DEFAULT_QUEUE_HEIGHT);
  });

  it('round-trips a saved height', () => {
    saveQueueHeight(342);
    expect(loadQueueHeight()).toBe(342);
  });

  it('rounds on save so no fractional pixel is persisted', () => {
    saveQueueHeight(342.7);
    expect(localStorage.getItem('queue-panel-height')).toBe('343');
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('queue-panel-height', 'not-a-number');
    expect(loadQueueHeight()).toBe(DEFAULT_QUEUE_HEIGHT);
  });

  it('ignores a nonsensical stored value', () => {
    localStorage.setItem('queue-panel-height', '-40');
    expect(loadQueueHeight()).toBe(DEFAULT_QUEUE_HEIGHT);
  });

  it('raises a too-small stored value to the minimum', () => {
    localStorage.setItem('queue-panel-height', '30');
    expect(loadQueueHeight()).toBe(MIN_QUEUE_HEIGHT);
  });
});
