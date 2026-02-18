/**
 * Procedural ambient sound generator using Web Audio API.
 * All presets are synthesized from oscillators + filters — no audio files needed.
 */

import type { AmbientPreset } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AmbientNodes {
  /** All source nodes that need stopping */
  sources: (OscillatorNode | AudioBufferSourceNode)[];
  /** All gain nodes for cleanup */
  gains: GainNode[];
  /** Master gain for volume control */
  master: GainNode;
  /** Interval IDs for random scheduled events */
  intervals: ReturnType<typeof setInterval>[];
  /** Timeout IDs for scheduled events */
  timeouts: ReturnType<typeof setTimeout>[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class AmbientEngine {
  private ctx: AudioContext | null = null;
  private nodes: AmbientNodes | null = null;
  private currentPreset: AmbientPreset = 'off';
  private volume = 0.3;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** Create a white noise buffer (1 second). */
  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, sampleRate, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleRate; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** Create a looping noise source. */
  private createNoiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = this.createNoiseBuffer(ctx);
    source.loop = true;
    return source;
  }

  // ---- Preset generators ---------------------------------------------------

  private buildRain(ctx: AudioContext, master: GainNode): AmbientNodes {
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const gains: GainNode[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // Continuous rain: filtered white noise
    const noise = this.createNoiseSource(ctx);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.4, ctx.currentTime);
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(3000, ctx.currentTime);
    bandpass.Q.setValueAtTime(0.5, ctx.currentTime);
    const highshelf = ctx.createBiquadFilter();
    highshelf.type = 'highshelf';
    highshelf.frequency.setValueAtTime(6000, ctx.currentTime);
    highshelf.gain.setValueAtTime(-6, ctx.currentTime);

    noise.connect(bandpass);
    bandpass.connect(highshelf);
    highshelf.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();
    sources.push(noise);
    gains.push(noiseGain);

    // Random droplet pops
    const dropInterval = setInterval(() => {
      if (!this.ctx || this.currentPreset !== 'rain') return;
      const freq = 2000 + Math.random() * 3000;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, ctx.currentTime + 0.05);
      g.gain.setValueAtTime(0.06 * Math.random(), ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.connect(g);
      g.connect(master);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    }, 80 + Math.random() * 120);
    intervals.push(dropInterval);

    return { sources, gains, master, intervals, timeouts };
  }

  private buildLofi(ctx: AudioContext, master: GainNode): AmbientNodes {
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const gains: GainNode[] = [];

    // Low-frequency hum with slight modulation
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60, ctx.currentTime);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.3, ctx.currentTime);
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(5, ctx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.35, ctx.currentTime);
    osc.connect(oscGain);
    oscGain.connect(master);
    osc.start();
    lfo.start();
    sources.push(osc, lfo);
    gains.push(oscGain, lfoGain);

    // Soft filtered noise bed
    const noise = this.createNoiseSource(ctx);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.08, ctx.currentTime);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(400, ctx.currentTime);
    noise.connect(lowpass);
    lowpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();
    sources.push(noise);
    gains.push(noiseGain);

    return { sources, gains, master, intervals: [], timeouts: [] };
  }

  private buildServerRoom(ctx: AudioContext, master: GainNode): AmbientNodes {
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const gains: GainNode[] = [];

    // Fan noise: filtered white noise
    const noise = this.createNoiseSource(ctx);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, ctx.currentTime);
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(500, ctx.currentTime);
    bandpass.Q.setValueAtTime(0.3, ctx.currentTime);
    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();
    sources.push(noise);
    gains.push(noiseGain);

    // Fan oscillator hum
    const fan = ctx.createOscillator();
    fan.type = 'triangle';
    fan.frequency.setValueAtTime(120, ctx.currentTime);
    const fanLfo = ctx.createOscillator();
    fanLfo.type = 'sine';
    fanLfo.frequency.setValueAtTime(0.1, ctx.currentTime);
    const fanLfoGain = ctx.createGain();
    fanLfoGain.gain.setValueAtTime(3, ctx.currentTime);
    fanLfo.connect(fanLfoGain);
    fanLfoGain.connect(fan.frequency);
    const fanGain = ctx.createGain();
    fanGain.gain.setValueAtTime(0.15, ctx.currentTime);
    fan.connect(fanGain);
    fanGain.connect(master);
    fan.start();
    fanLfo.start();
    sources.push(fan, fanLfo);
    gains.push(fanGain, fanLfoGain);

    // High frequency whine (typical server room)
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    whine.frequency.setValueAtTime(8000, ctx.currentTime);
    const whineGain = ctx.createGain();
    whineGain.gain.setValueAtTime(0.02, ctx.currentTime);
    whine.connect(whineGain);
    whineGain.connect(master);
    whine.start();
    sources.push(whine);
    gains.push(whineGain);

    return { sources, gains, master, intervals: [], timeouts: [] };
  }

  private buildDeepSpace(ctx: AudioContext, master: GainNode): AmbientNodes {
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const gains: GainNode[] = [];

    // Very low oscillator with slow modulation
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.setValueAtTime(40, ctx.currentTime);
    const droneLfo = ctx.createOscillator();
    droneLfo.type = 'sine';
    droneLfo.frequency.setValueAtTime(0.05, ctx.currentTime);
    const droneLfoGain = ctx.createGain();
    droneLfoGain.gain.setValueAtTime(8, ctx.currentTime);
    droneLfo.connect(droneLfoGain);
    droneLfoGain.connect(drone.frequency);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.3, ctx.currentTime);
    drone.connect(droneGain);

    // Reverb via convolver (simple impulse)
    const convolver = ctx.createConvolver();
    const impulseLen = ctx.sampleRate * 3;
    const impulse = ctx.createBuffer(2, impulseLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < impulseLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / impulseLen, 2.5);
      }
    }
    convolver.buffer = impulse;
    droneGain.connect(convolver);
    convolver.connect(master);

    drone.start();
    droneLfo.start();
    sources.push(drone, droneLfo);
    gains.push(droneGain, droneLfoGain);

    // Second harmonic
    const harmonic = ctx.createOscillator();
    harmonic.type = 'sine';
    harmonic.frequency.setValueAtTime(80, ctx.currentTime);
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.setValueAtTime(0.08, ctx.currentTime);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(convolver);
    harmonic.start();
    sources.push(harmonic);
    gains.push(harmonicGain);

    return { sources, gains, master, intervals: [], timeouts: [] };
  }

  private buildCoffeeShop(ctx: AudioContext, master: GainNode): AmbientNodes {
    const sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
    const gains: GainNode[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    // Murmur: filtered noise
    const noise = this.createNoiseSource(ctx);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.15, ctx.currentTime);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(1200, ctx.currentTime);
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.setValueAtTime(200, ctx.currentTime);
    noise.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();
    sources.push(noise);
    gains.push(noiseGain);

    // Random quiet dings (cup clinks, register dings)
    const dingInterval = setInterval(() => {
      if (!this.ctx || this.currentPreset !== 'coffeeShop') return;
      const freq = 1500 + Math.random() * 2000;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      g.gain.setValueAtTime(0.03 * Math.random(), ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.connect(g);
      g.connect(master);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    }, 2000 + Math.random() * 4000);
    intervals.push(dingInterval);

    return { sources, gains, master, intervals, timeouts };
  }

  // ---- Public API ----------------------------------------------------------

  /** Start playing an ambient preset. Stops any currently playing preset. */
  start(preset: AmbientPreset, volume?: number): void {
    this.stop();
    if (preset === 'off') return;

    if (volume !== undefined) {
      this.volume = Math.max(0, Math.min(1, volume));
    }

    const ctx = this.getCtx();
    this.currentPreset = preset;

    const master = ctx.createGain();
    master.gain.setValueAtTime(this.volume, ctx.currentTime);
    master.connect(ctx.destination);

    const builders: Record<string, (ctx: AudioContext, master: GainNode) => AmbientNodes> = {
      rain: (c, m) => this.buildRain(c, m),
      lofi: (c, m) => this.buildLofi(c, m),
      serverRoom: (c, m) => this.buildServerRoom(c, m),
      deepSpace: (c, m) => this.buildDeepSpace(c, m),
      coffeeShop: (c, m) => this.buildCoffeeShop(c, m),
    };

    const builder = builders[preset];
    if (builder) {
      this.nodes = builder(ctx, master);
    }
  }

  /** Stop the currently playing ambient sound. */
  stop(): void {
    if (!this.nodes) return;

    for (const interval of this.nodes.intervals) {
      clearInterval(interval);
    }
    for (const timeout of this.nodes.timeouts) {
      clearTimeout(timeout);
    }
    for (const source of this.nodes.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
    }
    for (const gain of this.nodes.gains) {
      gain.disconnect();
    }
    this.nodes.master.disconnect();
    this.nodes = null;
    this.currentPreset = 'off';
  }

  /** Set volume (0-1) for the ambient sounds. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.nodes) {
      const ctx = this.getCtx();
      this.nodes.master.gain.setValueAtTime(this.volume, ctx.currentTime);
    }
  }

  /** Get current volume. */
  getVolume(): number {
    return this.volume;
  }

  /** Get the currently playing preset. */
  getCurrentPreset(): AmbientPreset {
    return this.currentPreset;
  }

  /** Whether ambient sound is currently playing. */
  isPlaying(): boolean {
    return this.nodes !== null && this.currentPreset !== 'off';
  }

  /** Tear down the audio context. */
  dispose(): void {
    this.stop();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

/** Singleton instance. */
export const ambientEngine = new AmbientEngine();
