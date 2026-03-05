/**
 * ShortcutSettings — embedded shortcut configuration for the Settings panel.
 * Reuses ShortcutRow for rebinding. Groups by section.
 */
import { useState, useEffect, useCallback } from 'react';
import ShortcutRow from '@/components/modals/ShortcutRow';
import { useShortcutStore } from '@/stores/shortcutStore';
import { SECTION_ORDER } from '@/lib/shortcutKeys';
import { keyEventToCombo, isReservedOrModifierOnly } from '@/lib/shortcutKeys';
import type { ShortcutActionId } from '@/types/shortcut';
import styles from '@/styles/modules/Settings.module.css';
import scStyles from '@/styles/modules/ShortcutSettings.module.css';

export default function ShortcutSettings() {
  const bindings = useShortcutStore((s) => s.bindings);
  const rebind = useShortcutStore((s) => s.rebind);
  const resetOne = useShortcutStore((s) => s.resetOne);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const getConflict = useShortcutStore((s) => s.getConflict);

  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);
  const [conflictLabel, setConflictLabel] = useState<string | null>(null);

  // Capture-phase keydown listener for recording mode
  useEffect(() => {
    if (!recordingId) return;

    function handleCapture(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setRecordingId(null);
        setConflictLabel(null);
        return;
      }

      if (isReservedOrModifierOnly(e)) return;

      e.preventDefault();
      e.stopPropagation();

      const combo = keyEventToCombo(e);
      if (combo.key === '?') delete combo.shiftKey;

      const conflict = getConflict(combo, recordingId!);
      if (conflict) {
        setConflictLabel(conflict.label);
        return;
      }

      rebind(recordingId!, combo);
      setRecordingId(null);
      setConflictLabel(null);
    }

    document.addEventListener('keydown', handleCapture, true);
    return () => document.removeEventListener('keydown', handleCapture, true);
  }, [recordingId, rebind, getConflict]);

  const handleStartRecording = useCallback((actionId: ShortcutActionId) => {
    setRecordingId(actionId);
    setConflictLabel(null);
  }, []);

  const handleReset = useCallback(
    (actionId: ShortcutActionId) => {
      resetOne(actionId);
      if (recordingId === actionId) {
        setRecordingId(null);
        setConflictLabel(null);
      }
    },
    [resetOne, recordingId],
  );

  const handleResetAll = useCallback(() => {
    resetAll();
    setRecordingId(null);
    setConflictLabel(null);
  }, [resetAll]);

  // Group bindings by section
  const sections = SECTION_ORDER.map((section) => ({
    section,
    items: bindings.filter((b) => b.section === section),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <div className={styles.section}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>Keyboard Shortcuts</h4>
          <button className={styles.fontBtn} onClick={handleResetAll} style={{ fontSize: 10 }}>
            Reset All
          </button>
        </div>
        <p className={styles.settingsHint}>
          Click a key binding to change it. Press Escape to cancel. Session switch shortcuts let you jump between active sessions with Alt+1-9.
        </p>

        {sections.map((group) => (
          <div key={group.section} style={{ marginBottom: 16 }}>
            <div className={scStyles.sectionTitle}>{group.section}</div>
            <div className={scStyles.sectionList}>
              {group.items.map((binding) => (
                <ShortcutRow
                  key={binding.actionId}
                  binding={binding}
                  isRecording={recordingId === binding.actionId}
                  conflict={recordingId === binding.actionId ? conflictLabel : null}
                  onStartRecording={() => handleStartRecording(binding.actionId)}
                  onReset={() => handleReset(binding.actionId)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
