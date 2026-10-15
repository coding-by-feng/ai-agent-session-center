// AASC-21: the small pieces behind share, lock and haptics.
import { describe, expect, it, vi } from 'vitest';
import { HAPTIC_MIN_GAP_MS } from './haptics';
import { createHapticsDriver } from './hapticsDriver';
import { parseLockState, resumeAway } from './lockGate';
import { shareProblem, sharePreview } from './shareFlow';

describe('haptics driver', () => {
  it('plays what decideHaptic allows and keeps its limits', () => {
    let now = 10_000;
    const notify = vi.fn(async () => undefined);
    const driver = createHapticsDriver({ notify }, () => now);
    const change = (sessionId: string, from: string, to: string) => driver.sessionChanged({
      sessionId, prev: { status: from, hasInterruption: false }, next: { status: to, hasInterruption: false }, muted: false, appActive: true,
    });
    expect(change('a', 'working', 'approval')).toBe('warning');
    expect(change('b', 'working', 'waiting')).toBeNull(); // inside the global gap
    now += HAPTIC_MIN_GAP_MS;
    driver.ownAction('b');
    expect(change('b', 'working', 'waiting')).toBeNull(); // the phone's own action
    now += 5_000;
    expect(change('b', 'working', 'waiting')).toBe('success');
    expect(notify.mock.calls).toEqual([['warning'], ['success']]);
  });
});

describe('lock state and the resume path', () => {
  it('reads stored state and fails closed on anything odd', () => {
    expect(parseLockState(JSON.stringify({ unlockedAt: 5, unlockedBootId: 'b', backgroundedAt: null, tapStartedAt: 7 })))
      .toEqual({ unlockedAt: 5, unlockedBootId: 'b', backgroundedAt: null, tapStartedAt: 7 });
    expect(parseLockState('{bad').unlockedAt).toBeNull();
    expect(parseLockState(JSON.stringify({ unlockedAt: -1, unlockedBootId: 3 }))).toMatchObject({ unlockedAt: null, unlockedBootId: null });
  });

  it('takes the native pause time only when it is a past time', () => {
    expect(resumeAway('?resume=1&away=500&back=%2F', 1_000)).toBe(500);
    expect(resumeAway('?resume=1&away=5000', 1_000)).toBeNull();
    expect(resumeAway('?resume=1&away=x', 1_000)).toBeNull();
    expect(resumeAway('?reauth=1&away=500', 1_000)).toBeNull();
  });
});

describe('share preview and native refusals', () => {
  it('describes what is being shared in one line', () => {
    expect(sharePreview({ text: 'hello\n  world' })).toBe('“hello world”');
    expect(sharePreview({ text: 'x', images: [{ mimeType: 'image/png', base64: 'AA==' }, { mimeType: 'image/png', base64: 'AA==' }] })).toBe('“x” + 2 images');
    expect(sharePreview({ text: 'y'.repeat(300) }).length).toBeLessThan(150);
  });

  it('turns native refusal codes into the shell’s messages, and an unknown one into a safe line', () => {
    expect(shareProblem({ problem: 'too-large' })).toContain('about 2 MB');
    expect(shareProblem({ problem: '<script>' })).toBe('That couldn’t be shared. Nothing was added.'.replace('’', "'"));
    expect(shareProblem({ text: 'ok' })).toBeNull();
  });
});
