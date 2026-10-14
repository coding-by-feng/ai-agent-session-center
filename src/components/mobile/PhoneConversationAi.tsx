/**
 * PhoneConversationAi — the AI popup from the Conversation tab on a phone
 * (AASC-20). Select text (a long-press, then the handles) and an "Ask AI" bar
 * rises at the bottom of the screen, clear of the system's own Copy / Look Up
 * menu at the selection; it opens the actions sheet (PhoneAiPopupSheet).
 *
 * Off where the desktop popup is off: translation disabled, its trigger set to
 * off, or the session's own ✨ toggle (read through isAiPopupEnabled, so a
 * session that never set it is on).
 *
 * The selection is captured when a finger lands on the button, not when the tap
 * ends: on some phones the tap itself collapses the selection first, and the
 * bar (and the tap) would vanish with it.
 */
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { isAiPopupEnabled } from '@/lib/aiPopup';
import { captureSelectionIn, useSelectionIn } from '@/hooks/useSelectionIn';
import PhoneAiPopupSheet, { type PhoneSelection } from './PhoneAiPopupSheet';
import { SparkIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface PhoneConversationAiProps {
  /** The session whose Conversation this is: the popup forks it. */
  sessionId: string;
}

export default function PhoneConversationAi({ sessionId }: PhoneConversationAiProps) {
  const translationEnabled = useSettingsStore((s) => s.translationEnabled);
  const trigger = useSettingsStore((s) => s.translationTrigger);
  const sessionOn = useSessionStore((s) => isAiPopupEnabled(s.sessions.get(sessionId)));
  const enabled = translationEnabled && trigger !== 'off' && sessionOn;

  const live = useSelectionIn(sessionId, enabled);
  const [held, setHeld] = useState<PhoneSelection | null>(null);
  const [asking, setAsking] = useState<PhoneSelection | null>(null);

  const closeSheet = useCallback(() => setAsking(null), []);
  const ask = () => {
    const sel = held ?? captureSelectionIn(sessionId);
    setHeld(null);
    if (!sel) return;
    // The sheet has the text now; drop the page selection so the bar goes too.
    window.getSelection()?.removeAllRanges();
    setAsking(sel);
  };

  const preview = (held?.text ?? live).replace(/\s+/g, ' ');
  const showBar = enabled && !asking && preview !== '';

  return (
    <>
      {showBar && createPortal(
        <div className={styles.askBar} role="region" aria-label="Selected text">
          <span className={styles.askPreview}>“{preview}”</span>
          <button
            type="button"
            className={styles.askBtn}
            onPointerDown={() => setHeld(captureSelectionIn(sessionId))}
            onPointerCancel={() => setHeld(null)}
            onClick={ask}
          >
            <SparkIcon />
            Ask AI
          </button>
        </div>,
        document.body,
      )}
      <PhoneAiPopupSheet selection={asking} originSessionId={sessionId} onClose={closeSheet} />
    </>
  );
}
