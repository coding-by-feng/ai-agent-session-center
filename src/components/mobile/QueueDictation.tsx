/**
 * QueueDictation — the phone app's 🎙 in the queue's compose row (Nov 27 2026), beside the photo buttons. Tap,
 * speak, tap again: the words go into the "Add a prompt to the queue…" box at the caret when the box has the
 * focus, else at the end. Nothing is added to the queue or sent for you; ADD stays yours.
 *
 * The same recorder as the Chat composer and the terminal input (`usePhoneDictation`, `DictateButton`), so it
 * draws nothing where the app has no recorder (a browser, a desktop, an app from before Nov 16 2026). QueueTab
 * loads it on a phone only. Its one status line takes a row of its own under the buttons.
 */
import { useCallback } from 'react';
import { useQueueStore } from '@/stores/queueStore';
import { usePhoneDictation } from '@/hooks/usePhoneDictation';
import { insertDictation } from '@/lib/phoneDictation';
import DictateButton from './DictateButton';
import styles from '@/styles/modules/QueuePhone.module.css';

export interface QueueDictationProps {
  sessionId: string;
  /** The compose box, for the caret. */
  textarea: HTMLTextAreaElement | null;
  /** The compose row's button classes (Terminal.module.css). */
  buttonClassName: string;
}

export default function QueueDictation({ sessionId, textarea, buttonClassName }: QueueDictationProps) {
  // Read the draft when the words arrive, not when the recording started: the box may have changed since.
  const onSpoken = useCallback((spoken: string) => {
    const store = useQueueStore.getState();
    const current = store.getComposeDraft(sessionId).text;
    const focused = !!textarea && document.activeElement === textarea;
    const next = insertDictation(current, focused ? textarea.selectionStart : null, spoken);
    store.setComposeDraft(sessionId, { text: next.text });
    if (focused) requestAnimationFrame(() => textarea.setSelectionRange(next.caret, next.caret));
  }, [sessionId, textarea]);
  const dictation = usePhoneDictation(onSpoken);
  const { line, dismiss } = dictation;

  return (
    <>
      <DictateButton dictation={dictation} className={`${buttonClassName} ${styles.mic}`} />
      {line && line.tone === 'error' && (
        <p className={`${styles.dictateLine} ${styles.dictateError}`} role="alert" data-testid="dictation-line">
          <span>{line.text}</span>
          <button type="button" className={styles.dictateDismiss} onClick={dismiss} aria-label="Dismiss">✕</button>
        </p>
      )}
      {line && line.tone !== 'error' && (
        <p className={styles.dictateLine} role="status" data-testid="dictation-line">{line.text}</p>
      )}
    </>
  );
}
