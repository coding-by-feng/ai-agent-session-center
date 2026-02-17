import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SoundEngine, ACTION_LABELS, ACTION_CATEGORIES } from './soundEngine';
import type { SoundAction, SoundName } from './soundEngine';

// Minimal AudioContext mock — must use `function` keyword so `new AudioContext()` works.
function createMockAudioContext() {
  const mockGain = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      value: 1,
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockOsc = {
    type: 'sine' as OscillatorType,
    frequency: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      value: 440,
    },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    currentTime: 0,
    state: 'running' as AudioContextState,
    destination: {},
    createOscillator: vi.fn(() => ({ ...mockOsc })),
    createGain: vi.fn(() => ({ ...mockGain })),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SoundEngine', () => {
  let engine: SoundEngine;
  let mockCtx: ReturnType<typeof createMockAudioContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCtx = createMockAudioContext();
    // Use `function` so it works as a constructor with `new`
    vi.stubGlobal('AudioContext', function AudioContext() {
      return mockCtx;
    });
    engine = new SoundEngine();
  });

  afterEach(() => {
    engine.dispose();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('unlock', () => {
    it('marks the engine as unlocked', () => {
      expect(engine.isUnlocked()).toBe(false);
      engine.unlock();
      expect(engine.isUnlocked()).toBe(true);
    });

    it('resumes suspended AudioContext', () => {
      // Force context creation by playing a simple (non-sequence) sound
      engine.unlock();
      engine.setActionSound('sessionStart', 'click');
      engine.play('sessionStart');

      // Now the engine holds a reference to mockCtx — change its state
      mockCtx.state = 'suspended';
      engine.unlock();
      expect(mockCtx.resume).toHaveBeenCalled();
    });
  });

  describe('volume', () => {
    it('defaults to 0.5', () => {
      expect(engine.getVolume()).toBe(0.5);
    });

    it('sets volume within bounds', () => {
      engine.setVolume(0.8);
      expect(engine.getVolume()).toBe(0.8);
    });

    it('clamps volume to 0', () => {
      engine.setVolume(-0.5);
      expect(engine.getVolume()).toBe(0);
    });

    it('clamps volume to 1', () => {
      engine.setVolume(1.5);
      expect(engine.getVolume()).toBe(1);
    });
  });

  describe('action sounds', () => {
    it('returns default sounds for all actions', () => {
      const sounds = engine.getActionSounds();
      expect(sounds.sessionStart).toBe('chime');
      expect(sounds.toolRead).toBe('click');
      expect(sounds.toolBash).toBe('buzz');
      expect(sounds.approvalNeeded).toBe('alarm');
      expect(sounds.taskComplete).toBe('fanfare');
    });

    it('overrides a specific action sound', () => {
      engine.setActionSound('toolRead', 'ping');
      expect(engine.getActionSound('toolRead')).toBe('ping');
    });

    it('preserves defaults for non-overridden actions', () => {
      engine.setActionSound('toolRead', 'ping');
      expect(engine.getActionSound('toolWrite')).toBe('blip');
    });

    it('loadOverrides replaces all overrides', () => {
      engine.setActionSound('toolRead', 'ping');
      engine.loadOverrides({ toolBash: 'thud' });
      expect(engine.getActionSound('toolRead')).toBe('click'); // back to default
      expect(engine.getActionSound('toolBash')).toBe('thud'); // override
    });
  });

  describe('play', () => {
    it('returns false when not unlocked', () => {
      const result = engine.play('sessionStart');
      expect(result).toBe(false);
    });

    it('returns true and creates oscillator when unlocked', () => {
      engine.unlock();
      // Use 'click' which is a single playTone — no setTimeout
      engine.setActionSound('toolRead', 'click');
      const result = engine.play('toolRead');
      expect(result).toBe(true);
      expect(mockCtx.createOscillator).toHaveBeenCalled();
    });

    it('returns false for none sound', () => {
      engine.unlock();
      engine.setActionSound('toolRead', 'none');
      const result = engine.play('toolRead');
      expect(result).toBe(false);
    });

    it('plays sequence sounds with setTimeout', () => {
      engine.unlock();
      // sessionStart defaults to 'chime' which uses playSequence([523, 659, 784])
      engine.play('sessionStart');
      // All tones are scheduled via setTimeout — none fire until timers advance
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(0);
      vi.runAllTimers();
      // chime = 3 tones
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(3);
    });
  });

  describe('preview', () => {
    it('plays sound even when not unlocked', () => {
      // Use a single-tone sound to avoid setTimeout complications
      engine.preview('chirp');
      expect(mockCtx.createOscillator).toHaveBeenCalled();
    });

    it('creates oscillator for complex sounds', () => {
      engine.preview('warble');
      // warble uses 2 oscillators (main + lfo)
      expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
    });

    it('does nothing for none sound', () => {
      engine.preview('none');
      expect(mockCtx.createOscillator).not.toHaveBeenCalled();
    });
  });

  describe('getSoundNames', () => {
    it('returns all sound names', () => {
      const names = engine.getSoundNames();
      expect(names).toContain('chirp');
      expect(names).toContain('ping');
      expect(names).toContain('alarm');
      expect(names).toContain('urgentAlarm');
      expect(names).toContain('fanfare');
      expect(names).toContain('none');
      expect(names.length).toBe(16);
    });
  });

  describe('dispose', () => {
    it('closes AudioContext and resets unlock state', () => {
      engine.unlock();
      // Use a single-tone sound to force ctx creation without setTimeout
      engine.setActionSound('sessionStart', 'click');
      engine.play('sessionStart');
      engine.dispose();
      expect(mockCtx.close).toHaveBeenCalled();
      expect(engine.isUnlocked()).toBe(false);
    });
  });
});

describe('ACTION_LABELS', () => {
  it('has a label for every action in categories', () => {
    for (const category of ACTION_CATEGORIES) {
      for (const action of category.actions) {
        expect(ACTION_LABELS[action]).toBeDefined();
        expect(typeof ACTION_LABELS[action]).toBe('string');
      }
    }
  });
});

describe('ACTION_CATEGORIES', () => {
  it('has 3 categories', () => {
    expect(ACTION_CATEGORIES).toHaveLength(3);
  });

  it('covers all default actions', () => {
    const allActions = ACTION_CATEGORIES.flatMap((c) => c.actions);
    expect(allActions).toContain('sessionStart');
    expect(allActions).toContain('toolRead');
    expect(allActions).toContain('approvalNeeded');
    // urgentAlarm is a SoundName, not a SoundAction — it should NOT be in categories
    expect(allActions).not.toContain('urgentAlarm');
  });

  it('has no duplicate actions across categories', () => {
    const allActions = ACTION_CATEGORIES.flatMap((c) => c.actions);
    const unique = new Set(allActions);
    expect(allActions.length).toBe(unique.size);
  });
});
