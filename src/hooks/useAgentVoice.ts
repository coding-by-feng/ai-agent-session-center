/**
 * Drives the agent CLI's own voice feature from the terminal toolbar (see `lib/agentVoice.ts`).
 * `hold` (Claude): start() writes Space now and at key-repeat cadence until stop().
 * `toggle` (Codex): toggle() writes `/voice`, then `/voice stop`.
 * Switching terminal or unmounting ends a hold and forgets a toggle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLAUDE_TALK_KEY,
  CLAUDE_TALK_REPEAT_MS,
  CODEX_VOICE_START,
  CODEX_VOICE_STOP,
  type AgentVoiceKind,
} from '@/lib/agentVoice';

export interface AgentVoiceControls {
  active: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useAgentVoice(
  kind: AgentVoiceKind | null,
  terminalId: string | null,
  sendKeys: (data: string) => void,
): AgentVoiceControls {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toggleOnRef = useRef(false);
  const sendRef = useRef(sendKeys);
  useEffect(() => {
    sendRef.current = sendKeys;
  }, [sendKeys]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (kind !== 'hold' || timerRef.current !== null) return;
    sendRef.current(CLAUDE_TALK_KEY);
    timerRef.current = setInterval(() => sendRef.current(CLAUDE_TALK_KEY), CLAUDE_TALK_REPEAT_MS);
    setActive(true);
  }, [kind]);

  const stop = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimer();
    setActive(false);
  }, [clearTimer]);

  const toggle = useCallback(() => {
    if (kind !== 'toggle') return;
    const on = toggleOnRef.current;
    sendRef.current(on ? CODEX_VOICE_STOP : CODEX_VOICE_START);
    toggleOnRef.current = !on;
    setActive(!on);
  }, [kind]);

  // A new terminal (or CLI) starts from rest; never keep writing into one we left.
  useEffect(() => {
    return () => {
      clearTimer();
      toggleOnRef.current = false;
      setActive(false);
    };
  }, [terminalId, kind, clearTimer]);

  return { active, start, stop, toggle };
}
