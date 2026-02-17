/**
 * RobotViewport wraps a CharacterModel within the card's robot viewport area.
 * Manages animation state, emote effects, and color assignment.
 * Ported from the createRobot/updateRobot logic in public/js/robotManager.js.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { AnimationState, Emote, SessionStatus } from '@/types';
import CharacterModel, { type CharacterModelName } from './CharacterModel';
import { useSettingsStore } from '@/stores/settingsStore';

// ---------------------------------------------------------------------------
// Color palette for auto-assignment
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  '#00e5ff',
  '#ff9100',
  '#00ff88',
  '#ff3355',
  '#aa66ff',
  '#ffdd00',
  '#ff66aa',
  '#66ffdd',
];

let globalColorIndex = 0;

function getNextColor(): string {
  const color = COLOR_PALETTE[globalColorIndex % COLOR_PALETTE.length];
  globalColorIndex++;
  return color;
}

// ---------------------------------------------------------------------------
// Movement effect classes
// ---------------------------------------------------------------------------

type MovementEffect = 'shake' | 'bounce' | 'flash' | 'spin';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RobotViewportProps {
  sessionId: string;
  status: SessionStatus;
  animationState?: AnimationState;
  emote?: Emote;
  characterModel?: string;
  accentColor?: string;
}

export default function RobotViewport({
  sessionId,
  status,
  emote,
  characterModel,
  accentColor,
}: RobotViewportProps) {
  const globalModel = useSettingsStore((s) => s.characterModel);

  // Determine which character model to use
  const model: CharacterModelName = (characterModel || globalModel || 'robot').toLowerCase() as CharacterModelName;

  // Assign color: use provided accent, or auto-assign
  const [color] = useState<string>(() => {
    if (accentColor) return accentColor;
    const c = getNextColor();
    // Fire-and-forget save color to server
    fetch(`/api/sessions/${sessionId}/accent-color`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: c }),
    }).catch(() => {});
    return c;
  });

  // Emote one-shot effect
  const [emoting, setEmoting] = useState(false);
  const emoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (emote) {
      setEmoting(true);
      if (emoteTimerRef.current) clearTimeout(emoteTimerRef.current);
      emoteTimerRef.current = setTimeout(() => setEmoting(false), 600);
    }
    return () => {
      if (emoteTimerRef.current) clearTimeout(emoteTimerRef.current);
    };
  }, [emote]);

  // Movement effect classes (shake, bounce, flash, spin)
  const [effectClass, setEffectClass] = useState('');
  const effectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerEffect = useCallback((effect: MovementEffect) => {
    setEffectClass(effect);
    if (effectTimerRef.current) clearTimeout(effectTimerRef.current);
    effectTimerRef.current = setTimeout(() => setEffectClass(''), 500);
  }, []);

  // Trigger movement effects on status transitions
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === status) return;

    if (status === 'working') triggerEffect('bounce');
    else if (status === 'approval') triggerEffect('shake');
    else if (status === 'input') triggerEffect('flash');
    else if (status === 'ended') triggerEffect('spin');
  }, [status, triggerEffect]);

  // Checked state — stops waiting bounce after card is selected
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (status === 'waiting') {
      setChecked(false);
    }
  }, [status]);

  const viewportClassName = useMemo(() => {
    const classes = ['robot-viewport-inner'];
    if (effectClass) classes.push(effectClass);
    return classes.join(' ');
  }, [effectClass]);

  return (
    <div className={viewportClassName}>
      <CharacterModel
        model={model}
        status={status}
        color={color}
        emoting={emoting}
        checked={checked}
      />
    </div>
  );
}
