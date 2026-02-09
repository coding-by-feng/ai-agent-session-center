// soundManager.js — Per-action configurable sound effects via Web Audio API
import * as settingsManager from './settingsManager.js';

let audioCtx = null;
let enabled = true;
let volume = 0.5;
let actionSounds = {}; // action -> soundName mapping

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ---- Synthesis helpers ----

function playTone(freq, duration, type = 'sine', vol = 1) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(vol * volume * 0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

function playSequence(freqs, spacing = 0.1, duration = 0.15, type = 'sine') {
  freqs.forEach((f, i) => {
    setTimeout(() => playTone(f, duration, type), i * spacing * 1000);
  });
}

// ---- Sound Library ----

const soundLibrary = {
  chirp:    () => playTone(1200, 0.08, 'sine'),
  ping:     () => playTone(660, 0.2, 'sine'),
  chime:    () => playSequence([523, 659, 784], 0.08, 0.2),
  ding:     () => playTone(800, 0.25, 'triangle'),
  blip:     () => playTone(880, 0.05, 'square', 0.5),
  swoosh:   () => {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(volume * 0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  },
  click:    () => playTone(1200, 0.03, 'square', 0.2),
  beep:     () => playTone(440, 0.15, 'square', 0.4),
  warble:   () => {
    const ctx = getCtx();
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
    gain.gain.setValueAtTime(volume * 0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    lfo.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    lfo.stop(ctx.currentTime + 0.3);
  },
  buzz:     () => playTone(200, 0.12, 'sawtooth', 0.4),
  cascade:  () => playSequence([784, 659, 523, 392], 0.1, 0.2),
  fanfare:  () => playSequence([523, 659, 784, 1047, 1319], 0.08, 0.2),
  alarm:    () => playSequence([880, 660, 880, 660], 0.15, 0.15, 'square'),
  thud:     () => {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(volume * 0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  },
  none:     () => {}
};

// ---- Action types and default mapping ----

const defaultActionSounds = {
  // Session events
  sessionStart:   'chime',
  sessionEnd:     'cascade',
  promptSubmit:   'ping',
  taskComplete:   'fanfare',
  // Tool calls
  toolRead:       'click',
  toolWrite:      'blip',
  toolEdit:       'blip',
  toolBash:       'buzz',
  toolGrep:       'click',
  toolGlob:       'click',
  toolWebFetch:   'swoosh',
  toolTask:       'ding',
  toolOther:      'click',
  // System
  alert:          'alarm',
  kill:           'thud',
  archive:        'ding',
  subagentStart:  'chirp',
  subagentStop:   'ping'
};

const actionLabels = {
  sessionStart:   'Session Start',
  sessionEnd:     'Session End',
  promptSubmit:   'Prompt Submit',
  taskComplete:   'Task Complete',
  toolRead:       'Tool: Read',
  toolWrite:      'Tool: Write',
  toolEdit:       'Tool: Edit',
  toolBash:       'Tool: Bash',
  toolGrep:       'Tool: Grep',
  toolGlob:       'Tool: Glob',
  toolWebFetch:   'Tool: WebFetch',
  toolTask:       'Tool: Task',
  toolOther:      'Tool: Other',
  alert:          'Alert',
  kill:           'Kill',
  archive:        'Archive',
  subagentStart:  'Subagent Start',
  subagentStop:   'Subagent Stop'
};

const actionCategories = {
  'Session Events': ['sessionStart', 'sessionEnd', 'promptSubmit', 'taskComplete'],
  'Tool Calls':     ['toolRead', 'toolWrite', 'toolEdit', 'toolBash', 'toolGrep', 'toolGlob', 'toolWebFetch', 'toolTask', 'toolOther'],
  'System':         ['alert', 'kill', 'archive', 'subagentStart', 'subagentStop']
};

// ---- Public API ----

export function play(actionName) {
  if (!enabled) return;
  const soundName = actionSounds[actionName] || defaultActionSounds[actionName] || 'none';
  const fn = soundLibrary[soundName];
  if (fn) fn();
}

export function previewSound(soundName) {
  const fn = soundLibrary[soundName];
  if (fn) fn();
}

export function getSoundLibrary() {
  return Object.keys(soundLibrary);
}

export function getActionSounds() {
  return { ...defaultActionSounds, ...actionSounds };
}

export function getActionLabels() {
  return { ...actionLabels };
}

export function getActionCategories() {
  return actionCategories;
}

export function setActionSound(action, soundName) {
  actionSounds[action] = soundName;
  settingsManager.set('soundActions', JSON.stringify(actionSounds));
}

export function init() {
  enabled = settingsManager.get('soundEnabled') === 'true';
  volume = parseFloat(settingsManager.get('soundVolume')) || 0.5;

  // Load per-action config
  const saved = settingsManager.get('soundActions');
  if (saved) {
    try {
      actionSounds = JSON.parse(saved);
    } catch (e) {
      actionSounds = {};
    }
  }

  settingsManager.onChange('soundEnabled', (val) => { enabled = val === 'true'; });
  settingsManager.onChange('soundVolume', (val) => { volume = parseFloat(val) || 0.5; });

  // Resume audio context on first user interaction
  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });
}
