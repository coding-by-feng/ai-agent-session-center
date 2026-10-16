/**
 * PhoneSelectionAi — the AI popup over one phone surface's selected text
 * (AASC-20 for the Chat; AASC-57 for every surface: the Chat, a popup's answer,
 * the terminal's text, a project file).
 *
 * Select text (a long-press, then the handles) inside `[data-ai-selectable=<scopeId>]`
 * and an "Ask AI" bar rises at the bottom of the screen, clear of the system's own
 * Copy / Look Up menu at the selection; it opens the actions sheet
 * (PhoneAiPopupSheet). The surface's other buttons (an answer's "Ask AI", the file's
 * toolbar, the terminal's button) open the same sheet through phoneAiStore, so a
 * surface has one sheet, mounted here.
 *
 * Off where the desktop popup is off (useAiPopupsOn): translation disabled, its
 * trigger set to off, or the ROOT session's own switch (unset means on).
 *
 * The selection is captured when a finger lands on the button, not when the tap
 * ends: on some phones the tap itself collapses the selection first, and the bar
 * (and the tap) would vanish with it.
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { captureSelectionIn, useSelectionIn } from '@/hooks/useSelectionIn';
import { useAiPopupsOn } from '@/hooks/useAiPopupsOn';
import { usePhoneAiStore, type PhoneAiSelection } from '@/stores/phoneAiStore';
import type { AiSource } from '@/lib/floatingSpawn';
import PhoneAiPopupSheet from '../PhoneAiPopupSheet';
import { SparkIcon } from '../phoneIcons';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface PhoneSelectionAiProps {
  /** The surface's `data-ai-selectable` value. */
  scopeId: string;
  /** The ROOT session: the popup forks it (or the source's terminal's session) and shows under it. */
  originSessionId: string;
  source: AiSource;
  /** The surface sits in a sheet: the bar rises over the sheets. */
  overSheet?: boolean;
  /** After a popup started from here. */
  onSpawned?: () => void;
}

export default function PhoneSelectionAi({ scopeId, originSessionId, source, overSheet, onSpawned }: PhoneSelectionAiProps) {
  const enabled = useAiPopupsOn(originSessionId);
  const register = usePhoneAiStore((s) => s.register);
  const ask = usePhoneAiStore((s) => s.ask);
  const clear = usePhoneAiStore((s) => s.clear);
  const pending = usePhoneAiStore((s) => (s.pending?.scopeId === scopeId ? s.pending : null));

  // The scope takes popups only while they are on for its session.
  useEffect(() => (enabled ? register(scopeId) : undefined), [enabled, register, scopeId]);

  const live = useSelectionIn(scopeId, enabled);
  const [held, setHeld] = useState<PhoneAiSelection | null>(null);

  const closeSheet = useCallback(() => clear(scopeId), [clear, scopeId]);
  const onAsk = () => {
    const sel = held ?? captureSelectionIn(scopeId);
    setHeld(null);
    if (!sel) return;
    // The sheet has the text now; drop the page selection so the bar goes too.
    window.getSelection()?.removeAllRanges();
    ask(scopeId, sel);
  };

  const preview = (held?.text ?? live).replace(/\s+/g, ' ');
  const showBar = enabled && !pending && preview !== '';

  return (
    <>
      {showBar && createPortal(
        <div className={styles.askBar} role="region" aria-label="Selected text" data-over-sheet={overSheet ? '' : undefined}>
          <span className={styles.askPreview}>“{preview}”</span>
          <button
            type="button"
            className={styles.askBtn}
            onPointerDown={() => setHeld(captureSelectionIn(scopeId))}
            onPointerCancel={() => setHeld(null)}
            onClick={onAsk}
          >
            <SparkIcon />
            Ask AI
          </button>
        </div>,
        document.body,
      )}
      <PhoneAiPopupSheet
        open={enabled && !!pending}
        selection={pending?.selection ?? null}
        originSessionId={originSessionId}
        source={source}
        onClose={closeSheet}
        onSpawned={onSpawned}
      />
    </>
  );
}
