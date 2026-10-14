/**
 * ShortcutsPanel - Keyboard shortcuts reference overlay.
 * Triggered by pressing "?" or clicking the shortcuts button.
 * Reads bindings dynamically from the shortcut store.
 */
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useUiStore } from '@/stores/uiStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { SECTION_ORDER, keyComboToString } from '@/lib/shortcutKeys';
import styles from '@/styles/modules/Modal.module.css';

/** Non-customizable shortcuts shown alongside the store bindings. */
const EXTRA_SHORTCUTS: { section: string; items: { key: string; description: string }[] }[] = [
  {
    section: 'Terminal',
    items: [
      { key: 'Alt+Cmd/Ctrl+R', description: 'Refresh terminal' },
    ],
  },
  {
    section: 'File Browser',
    items: [
      { key: 'Cmd/Ctrl+F', description: 'Find in current file' },
      { key: 'Cmd/Ctrl+Shift+F', description: 'Global search across sessions' },
    ],
  },
];

/** Session-switch action IDs that should be collapsed into one row. */
const SESSION_SWITCH_RE = /^switchSession\d$/;

export default function ShortcutsPanel() {
  const bindings = useShortcutStore((s) => s.bindings);
  const openModal = useUiStore((s) => s.openModal);

  // Group store bindings by section, collapsing session-switch into one row
  const sections = SECTION_ORDER.map((section) => {
    const sectionBindings = bindings.filter((b) => b.section === section);
    const switchBindings = sectionBindings.filter((b) => SESSION_SWITCH_RE.test(b.actionId));
    // Skip unbound (null combo) entries — they add no value to the reference panel
    const otherBindings = sectionBindings
      .filter((b) => !SESSION_SWITCH_RE.test(b.actionId))
      .filter((b) => b.combo !== null);

    const storeItems = otherBindings.map((b) => ({
      key: keyComboToString(b.combo),
      description: b.label,
    }));

    // Collapse session-switch 1–9 into a single summary row
    if (switchBindings.length > 0) {
      const sample = switchBindings[0].combo;
      const prefix = sample ? [
        sample.ctrlKey && 'Ctrl',
        sample.altKey && 'Alt',
        sample.metaKey && 'Cmd',
        sample.shiftKey && 'Shift',
      ].filter(Boolean).join('+') : '';
      storeItems.unshift({
        key: prefix ? `${prefix}+1–9` : '1–9',
        description: 'Switch to session 1–9',
      });
    }

    const extraItems = EXTRA_SHORTCUTS
      .filter((g) => g.section === section)
      .flatMap((g) => g.items);
    return { section, items: [...storeItems, ...extraItems] };
  }).filter((g) => g.items.length > 0);

  return (
    <Modal modalId="shortcuts">
      <div className={styles.shortcutsPanel}>
        <div className={styles.shortcutsHeader}>
          <h3>KEYBOARD SHORTCUTS</h3>
        </div>
        <div className={styles.shortcutsBody}>
          {sections.map((group) => (
            <div key={group.section} className={styles.shortcutsSection}>
              <h4>{group.section}</h4>
              <div className={styles.shortcutList}>
                {group.items.map((item) => (
                  <div key={item.description} className={styles.shortcutRow}>
                    <span>{item.description}</span>
                    <kbd>{item.key}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* The shared kit (AASC-11): it was inline styles with a JS hover, no focus ring. */}
          <Button size="sm" className={styles.shortcutsCustomize} onClick={() => openModal('shortcut-settings')}>
            Customize…
          </Button>
        </div>
      </div>
    </Modal>
  );
}
