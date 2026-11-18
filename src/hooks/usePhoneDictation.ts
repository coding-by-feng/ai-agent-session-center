/**
 * The phone app's hold-to-talk dictation as one state machine (see `lib/phoneDictation.ts`):
 * `start()` on press, `stop()` on release; the app records, this Mac turns the clip into text, and
 * `onText` gets the words. `line` is the one sentence to show meanwhile, or after something went wrong.
 * Leaving the screen cancels a recording and drops a late answer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dictationBridge,
  requestTranscript,
  type DictationBridge,
  type DictationOutcome,
  type TranscriptResult,
} from '@/lib/phoneDictation';

/** How long the app has to hand the clip over after the button is let go. */
export const AUDIO_WAIT_MS = 8_000;
/** How long a hint (not an error) stays under the box. */
export const NOTE_MS = 4_000;

export type DictationPhase = 'idle' | 'recording' | 'transcribing';

export interface DictationLine {
  text: string;
  tone?: 'error';
}

export interface PhoneDictation {
  /** False where there is no recorder: show no button. */
  available: boolean;
  phase: DictationPhase;
  line: DictationLine | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  /** Clear an error line. */
  dismiss: () => void;
}

export interface PhoneDictationDeps {
  /** The app's recorder; `null` = none. Left out: looked up on `window`. */
  bridge?: DictationBridge | null;
  transcribe?: (audio: string, mime: string, signal: AbortSignal) => Promise<TranscriptResult>;
  newId?: () => string;
}

const PHASE_LINE: Record<Exclude<DictationPhase, 'idle'>, string> = {
  recording: 'Listening… let go when you’re done.',
  transcribing: 'Turning your words into text…',
};

function randomId(): string {
  return `d${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function permissionLine(granted: boolean): DictationLine {
  return granted
    ? { text: 'The microphone is on. Hold the mic to talk.' }
    : { text: 'AASC can’t use the microphone. Allow it in the phone’s Settings.', tone: 'error' };
}

const defaultTranscribe = (audio: string, mime: string, signal: AbortSignal): Promise<TranscriptResult> =>
  requestTranscript(audio, mime, fetch, signal);

export function usePhoneDictation(onText: (text: string) => void, deps: PhoneDictationDeps = {}): PhoneDictation {
  const [bridge] = useState<DictationBridge | null>(() => (deps.bridge !== undefined ? deps.bridge : dictationBridge()));
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [note, setNote] = useState<DictationLine | null>(null);

  // The live recording, outside render: the app's answers arrive between renders.
  const live = useRef<{ id: string; phase: DictationPhase } | null>(null);
  // The last recording asked for: its microphone answer may come after the hold has ended.
  const lastId = useRef<string | null>(null);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const onTextRef = useRef(onText);
  const transcribeRef = useRef(deps.transcribe ?? defaultTranscribe);
  const newIdRef = useRef(deps.newId ?? randomId);
  useEffect(() => {
    onTextRef.current = onText;
    transcribeRef.current = deps.transcribe ?? defaultTranscribe;
    newIdRef.current = deps.newId ?? randomId;
  }, [onText, deps.transcribe, deps.newId]);

  const clearWait = useCallback(() => {
    if (waitTimer.current !== null) clearTimeout(waitTimer.current);
    waitTimer.current = null;
  }, []);

  /** Show a line; a hint clears itself, an error waits for the next press. */
  const say = useCallback((next: DictationLine | null) => {
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    setNote(next);
    if (next && next.tone !== 'error') {
      noteTimer.current = setTimeout(() => {
        noteTimer.current = null;
        setNote(null);
      }, NOTE_MS);
    }
  }, []);

  const rest = useCallback((next: DictationLine | null) => {
    clearWait();
    live.current = null;
    setPhase('idle');
    say(next);
  }, [clearWait, say]);

  const transcribe = useCallback(async (id: string, audio: string, mime: string) => {
    clearWait();
    live.current = { id, phase: 'transcribing' };
    setPhase('transcribing');
    const gate = new AbortController();
    request.current = gate;
    const result = await transcribeRef.current(audio, mime, gate.signal);
    // Left the screen, or another recording took over: this answer has no box to go to.
    if (gate.signal.aborted || live.current?.id !== id) return;
    request.current = null;
    if (!result.ok) {
      rest({ text: result.message, tone: 'error' });
      return;
    }
    if (!result.text) {
      rest({ text: 'Didn’t catch that. Try again.' });
      return;
    }
    rest(null);
    onTextRef.current(result.text);
  }, [clearWait, rest]);

  const onOutcome = useCallback((outcome: DictationOutcome) => {
    const current = live.current;
    if (!current || outcome.id !== current.id) {
      // The phone's microphone question takes the touch, so the hold ends before its answer arrives:
      // that late answer still says what to do next, unless another recording has started since.
      if (!current && outcome.state === 'permission' && outcome.id === lastId.current) {
        lastId.current = null;
        say(permissionLine(outcome.granted));
      }
      return;
    }
    switch (outcome.state) {
      case 'recording':
        return;
      case 'permission':
        lastId.current = null;
        rest(permissionLine(outcome.granted));
        return;
      case 'cancelled':
        rest(outcome.short ? { text: 'Hold the mic while you talk, then let go.' } : null);
        return;
      case 'failed':
        rest({ text: outcome.message ?? 'The recording failed. Try again.', tone: 'error' });
        return;
      case 'audio':
        void transcribe(outcome.id, outcome.audio, outcome.mime);
    }
  }, [rest, say, transcribe]);

  useEffect(() => {
    if (!bridge) return undefined;
    const stopListening = bridge.listen(onOutcome);
    return () => {
      stopListening();
      const current = live.current;
      if (current?.phase === 'recording') bridge.post(current.id, 'cancel');
      live.current = null;
      request.current?.abort();
      request.current = null;
      if (waitTimer.current !== null) clearTimeout(waitTimer.current);
      if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    };
  }, [bridge, onOutcome]);

  const start = useCallback(() => {
    if (!bridge || live.current) return;
    const id = newIdRef.current();
    lastId.current = id;
    live.current = { id, phase: 'recording' };
    setPhase('recording');
    say(null);
    bridge.post(id, 'start');
  }, [bridge, say]);

  const stop = useCallback(() => {
    const current = live.current;
    if (!bridge || !current || current.phase !== 'recording') return;
    live.current = { id: current.id, phase: 'transcribing' };
    setPhase('transcribing');
    bridge.post(current.id, 'stop');
    clearWait();
    waitTimer.current = setTimeout(() => {
      waitTimer.current = null;
      if (live.current?.id === current.id) rest({ text: 'The app didn’t hand over the recording. Try again.', tone: 'error' });
    }, AUDIO_WAIT_MS);
  }, [bridge, clearWait, rest]);

  const cancel = useCallback(() => {
    const current = live.current;
    if (!bridge || !current || current.phase !== 'recording') return;
    bridge.post(current.id, 'cancel');
    rest(null);
  }, [bridge, rest]);

  const dismiss = useCallback(() => say(null), [say]);

  const line: DictationLine | null = phase === 'idle' ? note : { text: PHASE_LINE[phase] };
  return { available: bridge !== null, phase, line, start, stop, cancel, dismiss };
}
