/**
 * ShortcutRow — single row in the shortcut settings modal.
 * Shows label, clickable <kbd> for rebinding, and a reset button.
 */
import type { ShortcutBinding } from '@/types/shortcut';
import { keyComboToString } from '@/lib/shortcutKeys';
import { comboEquals } from '@/lib/shortcutKeys';
import styles from '@/styles/modules/ShortcutSettings.module.css';

interface ShortcutRowProps {
  binding: ShortcutBinding;
  isRecording: boolean;
  conflict: string | null;
  onStartRecording: () => void;
  onReset: () => void;
}

export default function ShortcutRow({
  binding,
  isRecording,
  conflict,
  onStartRecording,
  onReset,
}: ShortcutRowProps) {
  const isModified = !comboEquals(binding.combo, binding.defaultCombo);
  const displayText = isRecording ? 'Press key...' : keyComboToString(binding.combo);

  const kbdClass = [
    styles.kbd,
    isRecording ? styles.kbdRecording : '',
    !isRecording && isModified ? styles.kbdModified : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>{binding.label}</span>
        <div className={styles.rowRight}>
          <kbd className={kbdClass} onClick={onStartRecording} tabIndex={0}>
            {displayText}
          </kbd>
          {isModified && (
            <button
              className={styles.resetBtn}
              onClick={onReset}
              title="Reset to default"
              aria-label={`Reset ${binding.label} to default`}
            >
              ↺
            </button>
          )}
        </div>
      </div>
      {conflict && <div className={styles.conflict}>Already bound to: {conflict}</div>}
    </div>
  );
}
