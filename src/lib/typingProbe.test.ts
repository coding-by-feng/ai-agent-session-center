import { describe, it, expect, vi, afterEach } from 'vitest';
import { PROBE_GIVE_UP_MS, REPORT_EVERY, TYPING_PROBE_KEY, createTypingProbe, isTypingProbeEnabled, percentile, summarize } from './typingProbe';

describe('typingProbe', () => {
  afterEach(() => localStorage.removeItem(TYPING_PROBE_KEY));

  it('is off unless the flag is set', () => {
    expect(isTypingProbeEnabled()).toBe(false);
    localStorage.setItem(TYPING_PROBE_KEY, '1');
    expect(isTypingProbeEnabled()).toBe(true);
  });

  it('records round trip, server share and paint for one key', () => {
    const p = createTypingProbe('t', () => {});
    const id = p.noteKey(100)!;
    p.noteServer(id, 12);
    expect(p.noteOutput(130)).toBe(true);
    p.notePainted(140);
    expect(p.samples()).toEqual([{ roundTripMs: 30, serverMs: 12, paintMs: 10 }]);
  });

  it('samples one key at a time and only its first echo', () => {
    const p = createTypingProbe('t', () => {});
    expect(p.noteKey(0)).not.toBeNull();
    expect(p.noteKey(5)).toBeNull();
    expect(p.noteOutput(10)).toBe(true);
    expect(p.noteOutput(11)).toBe(false);
  });

  it('gives up on a key that never echoed', () => {
    const p = createTypingProbe('t', () => {});
    p.noteKey(0);
    expect(p.noteKey(PROBE_GIVE_UP_MS + 1)).not.toBeNull();
  });

  it('ignores a server reply for another key', () => {
    const p = createTypingProbe('t', () => {});
    const id = p.noteKey(0)!;
    p.noteServer(id + 1, 5);
    p.noteOutput(10);
    p.notePainted(12);
    expect(p.samples()[0].serverMs).toBeNull();
  });

  it('reports every REPORT_EVERY samples', () => {
    const report = vi.fn();
    const p = createTypingProbe('term-1', report);
    for (let i = 0; i < REPORT_EVERY; i++) {
      const t = i * 100;
      p.noteKey(t);
      p.noteOutput(t + 20);
      p.notePainted(t + 25);
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain('term-1');
    expect(report.mock.calls[0][0]).toContain('round trip 20/20');
  });

  it('summarizes percentiles and the wire share', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    const s = summarize([
      { roundTripMs: 30, serverMs: 25, paintMs: 4 },
      { roundTripMs: 40, serverMs: null, paintMs: 6 },
    ]);
    expect(s.server).toEqual({ p50: 25, p95: 25 });
    expect(s.wire).toEqual({ p50: 5, p95: 5 });
    expect(s.total.p95).toBe(46);
  });
});
