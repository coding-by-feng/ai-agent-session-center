import { describe, it, expect } from 'vitest';
import { decideRendererReload, MAX_RELOADS, RELOAD_WINDOW_MS } from '../electron/rendererRecovery.js';

describe('decideRendererReload', () => {
  it('reloads a crashed renderer and records the time', () => {
    expect(decideRendererReload('crashed', 1000, [])).toEqual({ reload: true, history: [1000] });
  });

  it('reloads on oom and abnormal-exit too', () => {
    expect(decideRendererReload('oom', 1, []).reload).toBe(true);
    expect(decideRendererReload('abnormal-exit', 1, []).reload).toBe(true);
  });

  it('never reloads a clean exit or a kill (app quit, OS kill)', () => {
    expect(decideRendererReload('clean-exit', 1, []).reload).toBe(false);
    expect(decideRendererReload('killed', 1, []).reload).toBe(false);
  });

  it(`stops after ${MAX_RELOADS} reloads inside the window, so a crash loop doesn't spin`, () => {
    let history: number[] = [];
    const results: boolean[] = [];
    for (let i = 0; i < MAX_RELOADS + 1; i++) {
      const d = decideRendererReload('crashed', 1000 + i, history);
      results.push(d.reload);
      history = d.history;
    }
    expect(results).toEqual([...Array(MAX_RELOADS).fill(true), false]);
  });

  it('forgets reloads older than the window', () => {
    const old = Array.from({ length: MAX_RELOADS }, (_, i) => i);
    const d = decideRendererReload('crashed', RELOAD_WINDOW_MS + MAX_RELOADS, old);
    expect(d).toEqual({ reload: true, history: [RELOAD_WINDOW_MS + MAX_RELOADS] });
  });

  it('does not mutate the history it was given', () => {
    const history = [5];
    decideRendererReload('crashed', 10, history);
    expect(history).toEqual([5]);
  });
});
