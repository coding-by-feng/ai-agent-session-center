import { useRef, useState } from 'react';
import UnfoldIcon from '@/components/ui/UnfoldIcon';
import { useTextClipped } from '@/hooks/useTextClipped';
import { useSettingsStore } from '@/stores/settingsStore';
import styles from '@/styles/modules/Terminal.module.css';

interface QueueItemTextProps {
  text: string;
  /** Show the whole prompt instead of the clipped preview. Owned by the caller. */
  expanded: boolean;
  onToggle: () => void;
}

/**
 * A queued prompt's text, and — when it is cut off — the toggle that shows all
 * of it. Shared by the list rows and the cards: the queue's other per-item
 * pieces (`renderItemMeta`, `renderItemActions`) are shared for the same
 * reason, so the two layouts cannot disagree about what an item looks like.
 *
 * The preview is one line with an ellipsis in a list row and a three-line clamp
 * in a card (Terminal.module.css). The toggle appears only while that preview
 * really hides something — or while the prompt is expanded, because then nothing
 * is cut off and the toggle is the only way back — or while it has keyboard
 * focus, so a fold never takes the focused button out from under the user.
 * A prompt that fits gets none.
 *
 * Where the toggle SITS is not decoration. In a list row it comes before the
 * text: the row's actions are shown only on hover and push the text's right edge
 * left, so a toggle at the end of the text slid out from under a tap (or a mouse
 * press) and the press landed on whichever action had arrived — DEL, on a plain
 * prompt. See `.queueList .queueExpandBtn`.
 */
export default function QueueItemText({ text, expanded, onToggle }: QueueItemTextProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const themeName = useSettingsStore((s) => s.themeName);
  const clipped = useTextClipped(textRef, text, { paused: expanded, remeasureKey: themeName });
  const [focused, setFocused] = useState(false);
  const label = expanded ? 'Collapse prompt' : 'Show full prompt';

  return (
    <div className={styles.queueTextLine}>
      <span
        ref={textRef}
        className={`${styles.queueText}${expanded ? ` ${styles.queueTextExpanded}` : ''}`}
        data-expanded={expanded}
      >
        {text}
      </span>
      {(clipped || expanded || focused) && (
        <button
          type="button"
          className={styles.queueExpandBtn}
          // The row is draggable and the card selectable; a click here is only this toggle.
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-expanded={expanded}
          aria-label={label}
          title={label}
        >
          <UnfoldIcon expanded={expanded} />
        </button>
      )}
    </div>
  );
}
