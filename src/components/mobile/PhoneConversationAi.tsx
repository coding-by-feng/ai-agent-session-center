/**
 * PhoneConversationAi — the AI popup from a session's Chat on a phone (AASC-20),
 * and from an AI popup's own answer (AASC-57). Select text and an "Ask AI" bar
 * rises; it opens the actions sheet. See PhoneSelectionAi.
 *
 * In a popup's answer the popup is the fork's parent (its terminal is sent as
 * `spawnTerminalId`, as the desktop's floating terminal does), while the ROOT
 * session stays the origin, so the new popup shows under the session on screen
 * instead of under a popup that is never selected.
 */
import { useMemo } from 'react';
import type { AiSource } from '@/lib/floatingSpawn';
import PhoneSelectionAi from './ai/PhoneSelectionAi';

export interface PhoneConversationAiProps {
  /** The session whose chat this is (its `data-ai-selectable` scope). */
  sessionId: string;
  /** This chat is an AI popup's answer: the session it shows under, and the popup's terminal. */
  popup?: { rootSessionId: string; terminalId: string };
}

export default function PhoneConversationAi({ sessionId, popup }: PhoneConversationAiProps) {
  const popupTerminal = popup?.terminalId;
  const source = useMemo<AiSource>(
    () => (popupTerminal ? { kind: 'popup', spawnTerminalId: popupTerminal } : { kind: 'chat' }),
    [popupTerminal],
  );
  return (
    <PhoneSelectionAi
      scopeId={sessionId}
      originSessionId={popup?.rootSessionId ?? sessionId}
      source={source}
      overSheet={!!popup}
    />
  );
}
