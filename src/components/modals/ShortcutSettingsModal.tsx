/**
 * ShortcutSettingsModal — standalone modal for viewing, rebinding, and resetting shortcuts.
 */
import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/ui/Modal';
import ShortcutRow from '@/components/modals/ShortcutRow';
import { useShortcutStore } from '@/stores/shortcutStore';
import { SECTION_ORDER } from '@/lib/shortcutKeys';
import { keyEventToCombo, isReservedOrModifierOnly } from '@/lib/shortcutKeys';
import type { ShortcutActionId } from '@/types/shortcut';
import styles from '@/styles/modules/ShortcutSettings.module.css';

export default function ShortcutSettingsModal() {
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
      // Escape cancels recording
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setRecordingId(null);
        setConflictLabel(null);
        return;
      }

      // Ignore modifier-only and reserved keys
      if (isReservedOrModifierOnly(e)) return;

      e.preventDefault();
      e.stopPropagation();

      const combo = keyEventToCombo(e);

      // For '?' key: store without shiftKey since '?' inherently requires Shift
      if (combo.key === '?') {
        delete combo.shiftKey;
      }

      // Check conflicts
      const conflict = getConflict(combo, recordingId!);
      if (conflict) {
        setConflictLabel(conflict.label);
        return;
      }

      // Apply binding
      rebind(recordingId!, combo);
      setRecordingId(null);
      setConflictLabel(null);
    }

    // Use capture phase to intercept before global handlers
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
    <Modal modalId="shortcut-settings">
      <div className={styles.container}>
        <div className={styles.header}>
          <h3>CUSTOMIZE SHORTCUTS</h3>
          <div className={styles.headerActions}>
            <button className={styles.resetAllBtn} onClick={handleResetAll}>
              Reset All
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {sections.map((group) => (
            <div key={group.section}>
              <div className={styles.sectionTitle}>{group.section}</div>
              <div className={styles.sectionList}>
                {group.items.map((binding) => (
                  <ShortcutRow
                    key={binding.actionId}
                    binding={binding}
                    isRecording={recordingId === binding.actionId}
                    conflict={
                      recordingId === binding.actionId ? conflictLabel : null
                    }
                    onStartRecording={() => handleStartRecording(binding.actionId)}
                    onReset={() => handleReset(binding.actionId)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
