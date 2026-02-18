/**
 * ShortcutsPanel - Keyboard shortcuts reference overlay.
 * Triggered by pressing "?" or clicking the shortcuts button.
 */
import Modal from '@/components/ui/Modal';
import styles from '@/styles/modules/Modal.module.css';

interface ShortcutDef {
  key: string;
  description: string;
}

const SHORTCUTS: { section: string; items: ShortcutDef[] }[] = [
  {
    section: 'Navigation',
    items: [
      { key: '/', description: 'Focus search' },
      { key: 'Escape', description: 'Close modal / deselect session' },
      { key: '?', description: 'Toggle this panel' },
    ],
  },
  {
    section: 'Actions',
    items: [
      { key: 'T', description: 'New terminal session' },
      { key: 'S', description: 'Toggle settings' },
      { key: 'M', description: 'Mute / unmute all' },
    ],
  },
  {
    section: 'Terminal',
    items: [
      { key: 'Alt+Cmd/Ctrl+R', description: 'Refresh terminal' },
      { key: 'Alt+F11', description: 'Toggle fullscreen' },
    ],
  },
  {
    section: 'Selected Session',
    items: [
      { key: 'K', description: 'Kill selected session' },
      { key: 'A', description: 'Archive selected session' },
    ],
  },
];

export default function ShortcutsPanel() {
  return (
    <Modal modalId="shortcuts">
      <div className={styles.shortcutsPanel}>
        <div className={styles.shortcutsHeader}>
          <h3>KEYBOARD SHORTCUTS</h3>
        </div>
        <div className={styles.shortcutsBody}>
          {SHORTCUTS.map((group) => (
            <div key={group.section} className={styles.shortcutsSection}>
              <h4>{group.section}</h4>
              <div className={styles.shortcutList}>
                {group.items.map((item) => (
                  <div key={item.key} className={styles.shortcutRow}>
                    <span>{item.description}</span>
                    <kbd>{item.key}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
