/**
 * DictateButton — the phone app's 🎙 (Nov 16 2026; tap-to-toggle since Nov 22 2026). Tap it and speak; tap it
 * again and the words are put in the box beside it (`usePhoneDictation`). Lifting the finger does not end the
 * recording, so the phone can be put down while talking; the app's own two-minute limit ends a forgotten one.
 * It draws nothing where the app has no recorder (a browser, a desktop, an app from before Nov 16 2026).
 *
 * The tap is taken on `pointerdown`: the app starts the microphone only just after a finger went down on the
 * screen, and a press never moves the focus, so the on-screen keyboard stays as it was. Space or Enter on a
 * hardware keyboard toggles too, but a start from a key gets the app's own "with a finger" answer.
 *
 * A box that goes off mid-recording (the session ended) drops the recording, and the button itself stays
 * enabled until the recording is over: a disabled button hears no finishing tap.
 */
import { useEffect, type KeyboardEvent, type PointerEvent } from 'react';
import type { PhoneDictation } from '@/hooks/usePhoneDictation';
import { MicIcon } from './phoneIcons';

const LABEL = {
  idle: 'Tap to dictate',
  recording: 'Recording: tap to finish',
  transcribing: 'Turning your words into text',
} as const;

export interface DictateButtonProps {
  dictation: PhoneDictation;
  /** The box can't be typed into (another device drives, the session ended…). */
  disabled?: boolean;
  className: string;
}

const isToggleKey = (e: KeyboardEvent): boolean => e.key === ' ' || e.key === 'Enter';

export default function DictateButton({ dictation, disabled = false, className }: DictateButtonProps) {
  const { available, phase, start, stop, cancel } = dictation;
  const recording = phase === 'recording';
  useEffect(() => {
    if (disabled && recording) cancel();
  }, [disabled, recording, cancel]);
  if (!available) return null;

  /** Idle starts, recording finishes; while the words are being turned into text a tap does nothing. */
  const toggle = () => {
    if (recording) stop();
    else if (phase === 'idle' && !disabled) start();
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // No focus change (the keyboard stays put) and no compatibility mouse events.
    e.preventDefault();
    toggle();
  };

  return (
    <button
      type="button"
      className={className}
      aria-label={LABEL[phase]}
      aria-pressed={recording}
      aria-busy={phase === 'transcribing' || undefined}
      disabled={disabled && !recording}
      data-phase={phase}
      data-testid="dictate-button"
      onPointerDown={onPointerDown}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isToggleKey(e)) return;
        e.preventDefault();
        if (!e.repeat) toggle();
      }}
      onKeyUp={(e) => {
        // Keep Space's key-up from clicking the button a second time.
        if (isToggleKey(e)) e.preventDefault();
      }}
    >
      <MicIcon filled={recording} />
    </button>
  );
}
