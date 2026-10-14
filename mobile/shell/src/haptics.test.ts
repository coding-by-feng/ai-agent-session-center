// haptics.test.ts — AASC-21 M8: which changes buzz the phone, and when not.
import { describe, it, expect } from 'vitest';
import {
  hapticForTransition, decideHaptic, noteOwnAction, INITIAL_HAPTICS_STATE,
  HAPTIC_MIN_GAP_MS, HAPTIC_SESSION_COOLDOWN_MS, OWN_ACTION_WINDOW_MS, type HapticInput, type HapticView,
} from './haptics';
import { decidePush } from '../../../server/push/pushRules';

const STATUSES = ['connecting', 'idle', 'prompting', 'working', 'approval', 'input', 'waiting', 'ended'];
const T0 = 1_760_000_000_000;

function view(status: string, hasInterruption = false): HapticView {
  return { status, hasInterruption };
}

function input(sessionId: string, from: string, to: string, extra: Partial<HapticInput> = {}): HapticInput {
  return { sessionId, prev: view(from), next: view(to), muted: false, appActive: true, ...extra };
}

describe('hapticForTransition', () => {
  it('maps each attention change to its haptic', () => {
    expect(hapticForTransition(view('working'), view('approval'))).toBe('warning');
    expect(hapticForTransition(view('working'), view('input'))).toBe('warning');
    expect(hapticForTransition(view('working'), view('waiting'))).toBe('success');
    expect(hapticForTransition(view('waiting'), view('waiting', true))).toBe('error');
    expect(hapticForTransition(undefined, view('approval'))).toBeNull();
    expect(hapticForTransition(view('idle'), view('working'))).toBeNull();
  });

  it('fires on exactly the transitions the Mac pushes for', () => {
    const haptic = { approval: 'warning', input: 'warning', finished: 'success', interrupted: 'error' } as const;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        for (const [a, b] of [[false, false], [false, true], [true, true], [true, false]]) {
          const kind = decidePush({ status: from, hasInterruption: a }, { status: to, hasInterruption: b });
          expect(hapticForTransition(view(from, a), view(to, b))).toBe(kind ? haptic[kind] : null);
        }
      }
    }
  });
});

describe('decideHaptic', () => {
  it('buzzes in the foreground and records it immutably', () => {
    const out = decideHaptic(INITIAL_HAPTICS_STATE, input('s1', 'working', 'approval'), T0);
    expect(out.haptic).toBe('warning');
    expect(out.state).toEqual({ lastAt: T0, bySession: { s1: T0 }, ownActions: {} });
    expect(INITIAL_HAPTICS_STATE.lastAt).toBeNull();
  });

  it('stays still in the background and for muted sessions', () => {
    expect(decideHaptic(INITIAL_HAPTICS_STATE, input('s1', 'working', 'approval', { appActive: false }), T0).haptic).toBeNull();
    expect(decideHaptic(INITIAL_HAPTICS_STATE, input('s1', 'working', 'approval', { muted: true }), T0).haptic).toBeNull();
  });

  it("doesn't buzz for the phone's own action", () => {
    const acted = noteOwnAction(INITIAL_HAPTICS_STATE, 's1', T0);
    expect(decideHaptic(acted, input('s1', 'working', 'waiting', { next: view('waiting', true) }), T0 + 1_000).haptic).toBeNull();
    expect(decideHaptic(acted, input('s2', 'working', 'waiting'), T0 + 1_000).haptic).toBe('success');
    expect(decideHaptic(acted, input('s1', 'working', 'waiting'), T0 + OWN_ACTION_WINDOW_MS).haptic).toBe('success');
  });

  it('is rate-limited across sessions and per session', () => {
    const first = decideHaptic(INITIAL_HAPTICS_STATE, input('s1', 'working', 'approval'), T0);
    expect(decideHaptic(first.state, input('s2', 'working', 'input'), T0 + HAPTIC_MIN_GAP_MS - 1).haptic).toBeNull();
    expect(decideHaptic(first.state, input('s2', 'working', 'input'), T0 + HAPTIC_MIN_GAP_MS).haptic).toBe('warning');
    expect(decideHaptic(first.state, input('s1', 'approval', 'waiting'), T0 + HAPTIC_SESSION_COOLDOWN_MS - 1).haptic).toBeNull();
    expect(decideHaptic(first.state, input('s1', 'approval', 'waiting'), T0 + HAPTIC_SESSION_COOLDOWN_MS).haptic).toBe('success');
  });

  it('forgets old timestamps so its state stays small', () => {
    let state = INITIAL_HAPTICS_STATE;
    for (let i = 0; i < 100; i++) state = decideHaptic(state, input(`s${i}`, 'working', 'approval'), T0 + i * HAPTIC_SESSION_COOLDOWN_MS).state;
    expect(Object.keys(state.bySession)).toEqual(['s99']);
  });
});
