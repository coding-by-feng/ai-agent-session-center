/**
 * Web Audio synthesis engine.
 * Ported from public/js/soundManager.js — zero dependencies, pure synthesis.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Individual sound names available in the library */
export type SoundName =
  | 'chirp'
  | 'ping'
  | 'chime'
  | 'ding'
  | 'blip'
  | 'swoosh'
  | 'click'
  | 'beep'
  | 'warble'
  | 'buzz'
  | 'cascade'
  | 'fanfare'
  | 'alarm'
  | 'thud'
  | 'urgentAlarm'
  | 'none';

/** Action names that trigger sounds */
export type SoundAction =
  // Session events
  | 'sessionStart'
  | 'sessionEnd'
  | 'promptSubmit'
  | 'taskComplete'
  // Tool calls
  | 'toolRead'
  | 'toolWrite'
  | 'toolEdit'
  | 'toolBash'
  | 'toolGrep'
  | 'toolGlob'
  | 'toolWebFetch'
  | 'toolTask'
  | 'toolOther'
  // System
  | 'approvalNeeded'
  | 'inputNeeded'
  | 'alert'
  | 'kill'
  | 'archive'
  | 'subagentStart'
  | 'subagentStop';

export interface ActionCategory {
  label: string;
  actions: SoundAction[];
}

// ---------------------------------------------------------------------------
// Default action -> sound mapping
// ---------------------------------------------------------------------------

const DEFAULT_ACTION_SOUNDS: Record<SoundAction, SoundName> = {
  sessionStart: 'chime',
  sessionEnd: 'cascade',
  promptSubmit: 'ping',
  taskComplete: 'fanfare',
  toolRead: 'click',
  toolWrite: 'blip',
  toolEdit: 'blip',
  toolBash: 'buzz',
  toolGrep: 'click',
  toolGlob: 'click',
  toolWebFetch: 'swoosh',
  toolTask: 'ding',
  toolOther: 'click',
  approvalNeeded: 'alarm',
  inputNeeded: 'chime',
  alert: 'alarm',
  kill: 'thud',
  archive: 'ding',
  subagentStart: 'chirp',
  subagentStop: 'ping',
};

export const ACTION_LABELS: Record<SoundAction, string> = {
  sessionStart: 'Session Start',
  sessionEnd: 'Session End',
  promptSubmit: 'Prompt Submit',
  taskComplete: 'Task Complete',
  toolRead: 'Tool: Read',
  toolWrite: 'Tool: Write',
  toolEdit: 'Tool: Edit',
  toolBash: 'Tool: Bash',
  toolGrep: 'Tool: Grep',
  toolGlob: 'Tool: Glob',
  toolWebFetch: 'Tool: WebFetch',
  toolTask: 'Tool: Task',
  toolOther: 'Tool: Other',
  approvalNeeded: 'Approval Needed',
  inputNeeded: 'Input Needed',
  alert: 'Alert',
  kill: 'Kill',
  archive: 'Archive',
  subagentStart: 'Subagent Start',
  subagentStop: 'Subagent Stop',
};

export const ACTION_CATEGORIES: ActionCategory[] = [
  {
    label: 'Session Events',
    actions: ['sessionStart', 'sessionEnd', 'promptSubmit', 'taskComplete'],
  },
  {
    label: 'Tool Calls',
    actions: [
      'toolRead', 'toolWrite', 'toolEdit', 'toolBash',
      'toolGrep', 'toolGlob', 'toolWebFetch', 'toolTask', 'toolOther',
    ],
  },
  {
    label: 'System',
    actions: [
      'approvalNeeded', 'inputNeeded', 'alert',
      'kill', 'archive', 'subagentStart', 'subagentStop',
    ],
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private unlocked = false;
  private volume = 0.5;
  private actionOverrides: Partial<Record<SoundAction, SoundName>> = {};

  /** Lazily create / resume AudioContext. */
  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  // ---- Synthesis primitives ------------------------------------------------

  private playTone(
    freq: number,
    duration: number,
    type: OscillatorType = 'sine',
    vol = 1,
  ): void {
    const ctx = this.getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol * this.volume * 0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  private playSequence(
    freqs: number[],
    spacing = 0.1,
    duration = 0.15,
    type: OscillatorType = 'sine',
  ): void {
    freqs.forEach((f, i) => {
      setTimeout(() => this.playTone(f, duration, type), i * spacing * 1000);
    });
  }

  // ---- Sound library -------------------------------------------------------

  private readonly sounds: Record<SoundName, () => void> = {
    chirp: () => this.playTone(1200, 0.08, 'sine'),
    ping: () => this.playTone(660, 0.2, 'sine'),
    chime: () => this.playSequence([523, 659, 784], 0.08, 0.2),
    ding: () => this.playTone(800, 0.25, 'triangle'),
    blip: () => this.playTone(880, 0.05, 'square', 0.5),
    swoosh: () => {
      const ctx = this.getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(this.volume * 0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    },
    click: () => this.playTone(1200, 0.03, 'square', 0.2),
    beep: () => this.playTone(440, 0.15, 'square', 0.4),
    warble: () => {
      const ctx = this.getCtx();
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(12, ctx.currentTime);
      lfoGain.gain.setValueAtTime(50, ctx.currentTime);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      gain.gain.setValueAtTime(this.volume * 0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      lfo.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
      lfo.stop(ctx.currentTime + 0.3);
    },
    buzz: () => this.playTone(200, 0.12, 'sawtooth', 0.4),
    cascade: () => this.playSequence([784, 659, 523, 392], 0.1, 0.2),
    fanfare: () => this.playSequence([523, 659, 784, 1047, 1319], 0.08, 0.2),
    alarm: () => this.playSequence([880, 660, 880, 660], 0.15, 0.15, 'square'),
    thud: () => {
      const ctx = this.getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(80, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(this.volume * 0.5, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    },
    urgentAlarm: () => {
      const ctx = this.getCtx();
      const t = ctx.currentTime;
      for (let burst = 0; burst < 3; burst++) {
        const offset = burst * 0.4;
        // High tone
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'square';
        osc1.frequency.setValueAtTime(1000, t + offset);
        osc1.frequency.setValueAtTime(800, t + offset + 0.1);
        osc1.frequency.setValueAtTime(1000, t + offset + 0.2);
        gain1.gain.setValueAtTime(this.volume * 0.5, t + offset);
        gain1.gain.setValueAtTime(this.volume * 0.5, t + offset + 0.25);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.3);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(t + offset);
        osc1.stop(t + offset + 0.3);
        // Low undertone
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sawtooth';
        osc2.frequency.setValueAtTime(200, t + offset);
        gain2.gain.setValueAtTime(this.volume * 0.3, t + offset);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.3);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(t + offset);
        osc2.stop(t + offset + 0.3);
      }
    },
    none: () => {},
  };

  // ---- Public API ----------------------------------------------------------

  /** Call once after first user gesture (click/key/touch) to unlock audio. */
  unlock(): void {
    this.unlocked = true;
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Whether the engine has been unlocked by user interaction. */
  isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Set master volume (0-1). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  /** Get current master volume. */
  getVolume(): number {
    return this.volume;
  }

  /** Override which sound plays for a given action. */
  setActionSound(action: SoundAction, sound: SoundName): void {
    this.actionOverrides = { ...this.actionOverrides, [action]: sound };
  }

  /** Get the resolved sound for an action (override or default). */
  getActionSound(action: SoundAction): SoundName {
    return this.actionOverrides[action] ?? DEFAULT_ACTION_SOUNDS[action] ?? 'none';
  }

  /** Get all action-sound mappings (defaults merged with overrides). */
  getActionSounds(): Record<SoundAction, SoundName> {
    return { ...DEFAULT_ACTION_SOUNDS, ...this.actionOverrides };
  }

  /** Load overrides from a saved record. */
  loadOverrides(overrides: Partial<Record<SoundAction, SoundName>>): void {
    this.actionOverrides = { ...overrides };
  }

  /** Get list of all available sound names. */
  getSoundNames(): SoundName[] {
    return Object.keys(this.sounds) as SoundName[];
  }

  /** Play the sound mapped to a given action. Returns false if muted/locked. */
  play(action: SoundAction): boolean {
    if (!this.unlocked) return false;
    const soundName = this.getActionSound(action);
    const fn = this.sounds[soundName];
    if (fn) fn();
    return soundName !== 'none';
  }

  /** Play a sound directly by name (for previews in settings). */
  preview(soundName: SoundName): void {
    const fn = this.sounds[soundName];
    if (fn) fn();
  }

  /** Tear down the AudioContext. */
  dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.unlocked = false;
  }
}

/** Singleton instance. */
export const soundEngine = new SoundEngine();
