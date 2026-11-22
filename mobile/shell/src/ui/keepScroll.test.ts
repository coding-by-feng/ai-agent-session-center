import { describe, it, expect } from 'vitest';
import { applyScroll, readScroll, type ScrollBox } from './keepScroll.js';

const box = (scrollTop: number, scrollHeight = 1000, clientHeight = 300): ScrollBox => ({ scrollTop, scrollHeight, clientHeight });

describe('keepScroll', () => {
  it('reads nothing from no list', () => {
    expect(readScroll(null)).toBeNull();
  });

  it('keeps a reader who scrolled up where they were across a redraw', () => {
    const memo = readScroll(box(120));
    const fresh = box(0, 1200);
    applyScroll(fresh, memo);
    expect(fresh.scrollTop).toBe(120);
  });

  it('follows the bottom when the reader was at the bottom (a new line arrived)', () => {
    const memo = readScroll(box(700)); // 1000 - 700 - 300 = 0 from the end
    const fresh = box(0, 1100);
    applyScroll(fresh, memo);
    expect(fresh.scrollTop).toBe(1100);
  });

  it('counts a few pixels short of the end as the bottom', () => {
    expect(readScroll(box(680))?.atBottom).toBe(true);
    expect(readScroll(box(600))?.atBottom).toBe(false);
  });

  it('starts at the bottom when the list is new (first draw or just expanded)', () => {
    const fresh = box(0);
    applyScroll(fresh, null);
    expect(fresh.scrollTop).toBe(1000);
  });

  it('does nothing when the screen has no list', () => {
    expect(() => applyScroll(null, { top: 5, atBottom: false })).not.toThrow();
  });
});
