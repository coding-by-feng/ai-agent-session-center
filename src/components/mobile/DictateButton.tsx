/**
 * DictateButton — the phone app's hold-to-talk 🎙 (Nov 16 2026). Hold it and speak; let go and the words
 * are put in the box beside it (`usePhoneDictation`). It draws nothing where the app has no recorder
 * (a browser, a desktop, an app from before this build).
 *
 * The hold is a pointer hold, captured so a finger sliding off still ends it. A press never moves the
 * focus, so the on-screen keyboard stays as it was. The app records only while a finger is on the
 * screen, so Space or Enter held on a hardware keyboard gets the app's own "hold it with a finger" answer.
 *
 * A box that goes off mid-hold (the session ended) drops the recording: a disabled button hears no
 * release, and the mic would stay on until the app's two-minute limit. So the button itself stays
 * enabled until the recording is over.
 */
import { useEffect, type KeyboardEvent, type PointerEvent } from 'react';
import type { PhoneDictation } from '@/hooks/usePhoneDictation';
import { MicIcon } from './phoneIcons';

const LABEL = {
  idle: 'Hold to dictate',
  recording: 'Recording: let go to finish',
  transcribing: 'Turning your words into text',
} as const;

export interface DictateButtonProps {
  dictation: PhoneDictation;
  /** The box can't be typed into (another device drives, the session ended…). */
  disabled?: boolean;
  className: string;
}

const isHoldKey = (e: KeyboardEvent): boolean => e.key === ' ' || e.key === 'Enter';

export default function DictateButton({ dictation, disabled = false, className }: DictateButtonProps) {
  const { available, phase, start, stop, cancel } = dictation;
  const recording = phase === 'recording';
  useEffect(() => {
    if (disabled && recording) cancel();
  }, [disabled, recording, cancel]);
  if (!available) return null;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // No focus change (the keyboard stays put) and no compatibility mouse events.
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the release below still arrives or the app's own limit ends it.
    }
    start();
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
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isHoldKey(e)) return;
        e.preventDefault();
        if (!e.repeat) start();
      }}
      onKeyUp={(e) => {
        if (!isHoldKey(e)) return;
        e.preventDefault();
        stop();
      }}
      onBlur={stop}
    >
      <MicIcon filled={recording} />
    </button>
  );
}
