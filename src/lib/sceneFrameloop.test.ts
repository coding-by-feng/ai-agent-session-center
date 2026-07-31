import { describe, it, expect } from 'vitest';
import {
  resolveFrameloop,
  needsFramePump,
  UNFOCUSED_FPS,
  UNFOCUSED_FRAME_MS,
} from './sceneFrameloop';

describe('resolveFrameloop', () => {
  it('renders at full rate only when visible AND focused', () => {
    expect(resolveFrameloop(true, true)).toBe('always');
  });

  it('stops the loop entirely when the window is hidden', () => {
    // The case that motivated this: Electron disables MacWebContentsOcclusion, so
    // a covered/minimised window keeps rAF running at 60 fps without this gate.
    expect(resolveFrameloop(false, true)).toBe('never');
    expect(resolveFrameloop(false, false)).toBe('never');
  });

  it('drops to demand when visible but unfocused', () => {
    expect(resolveFrameloop(true, false)).toBe('demand');
  });
});

describe('needsFramePump', () => {
  it('is true only in the demand state', () => {
    expect(needsFramePump(true, false)).toBe(true);
    expect(needsFramePump(true, true)).toBe(false);
    expect(needsFramePump(false, false)).toBe(false);
  });
});

describe('pump constants', () => {
  it('keeps the unfocused rate well below 60 fps but still animating', () => {
    expect(UNFOCUSED_FPS).toBeGreaterThan(0);
    expect(UNFOCUSED_FPS).toBeLessThan(60);
  });

  it('derives the interval from the fps', () => {
    expect(UNFOCUSED_FRAME_MS).toBe(Math.round(1000 / UNFOCUSED_FPS));
  });
});
