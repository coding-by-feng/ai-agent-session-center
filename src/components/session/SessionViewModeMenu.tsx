/**
 * SessionViewModeMenu — the one button in the session strip's header that picks
 * how the strip is laid out: Rooms (the default), Projects, or a flat list by
 * Recent activity. Its glyph shows the view you are in.
 *
 * It takes the slot the old room ⇄ activity toggle had instead of adding a
 * second toggle beside it: the header's icon row is sized to eight 26px
 * children in the 230px left rail (see `.switcherBarVertical .switcherMeta`),
 * and a ninth would push another icon onto a second line.
 *
 * The dropdown reuses the room filter's styles and, like it, anchors `right: 0`,
 * so `useDropdownFlipX` keeps it on screen when the trigger sits near the
 * window's left edge.
 */
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactElement } from 'react';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { useDropdownFlipX } from '@/hooks/useDropdownFlipX';
import type { SessionSortMode } from '@/stores/uiStore';
import styles from '@/styles/modules/DetailPanel.module.css';

/** A room frame: the box with its name set into the top edge, one card inside.
 *  Not the 2x2 grid (that is the density toggle's) and not two stacked bars
 *  (that is its compact state's): the notch in the top edge is what says "a
 *  frame with a name". */
function RoomViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5 2.4H3.4a1.9 1.9 0 0 0-1.9 1.9v6.3a1.9 1.9 0 0 0 1.9 1.9h7.2a1.9 1.9 0 0 0 1.9-1.9V4.3a1.9 1.9 0 0 0-1.9-1.9H9.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M6 2.4h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="4.2" y="6" width="5.6" height="3.6" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** A folder: the project's directory. The file tree's own glyph, reused. */
function ProjectViewIcon() {
  return <FileTypeIcon name="project" isDir />;
}

/** Descending bars + down arrow — the flat "most recently active first" list. */
function ActivityViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1 3.5H8M1 7H6M1 10.5H4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M11 2.5V11M9.2 9.2L11 11L12.8 9.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <polyline points="2.5,6.3 5,8.8 9.5,3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const VIEWS: ReadonlyArray<{
  mode: SessionSortMode;
  label: string;
  hint: string;
  Icon: () => ReactElement;
}> = [
  { mode: 'room', label: 'Rooms', hint: 'Group sessions into their rooms', Icon: RoomViewIcon },
  {
    mode: 'project',
    label: 'Projects',
    hint: 'Group sessions by project directory, with buttons to start a new one',
    Icon: ProjectViewIcon,
  },
  { mode: 'activity', label: 'Recent activity', hint: 'One flat list, most recently active first', Icon: ActivityViewIcon },
];

interface Props {
  mode: SessionSortMode;
  onChange: (mode: SessionSortMode) => void;
}

export default function SessionViewModeMenu({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const checkedRef = useRef<HTMLButtonElement>(null);
  useDropdownFlipX(open, menuRef);

  // Close on a click anywhere outside the button and its menu.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Opening moves focus to the current view, so the menu is usable from the keyboard.
  useEffect(() => {
    if (open) checkedRef.current?.focus();
  }, [open]);

  const current = VIEWS.find((v) => v.mode === mode) ?? VIEWS[0];

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    // A role="menu" promises arrow-key movement between its items.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const options = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (options.length === 0) return;
    e.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLElement);
    let target: number;
    if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = options.length - 1;
    else if (e.key === 'ArrowDown') target = at + 1 >= options.length ? 0 : at + 1;
    else target = at <= 0 ? options.length - 1 : at - 1;
    options[target].focus();
  };

  // Tab out of the menu to another control: close it. Only when focus lands somewhere known and outside — a
  // null `relatedTarget` (a click on a non-focusable area; Safari never focuses a clicked button) is the
  // outside-mousedown handler's business, and closing here would swallow the click on an option.
  const onBlur = (e: FocusEvent) => {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (next && wrapRef.current && !wrapRef.current.contains(next)) setOpen(false);
  };

  const choose = (next: SessionSortMode) => {
    setOpen(false);
    // The option being clicked is about to unmount; without this, focus falls to <body>.
    triggerRef.current?.focus();
    if (next !== mode) onChange(next);
  };

  return (
    <div className={styles.roomFilterWrap} ref={wrapRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        className={`${styles.displayModeToggle}${mode !== 'room' ? ` ${styles.roomFilterActive}` : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={`Session view: ${current.label} — click to change`}
        aria-label={`Session view: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        type="button"
      >
        <current.Icon />
      </button>
      {open && (
        <div className={styles.roomFilterDropdown} ref={menuRef} role="menu" aria-label="Session view">
          {VIEWS.map(({ mode: optionMode, label, hint, Icon }) => {
            const checked = optionMode === mode;
            return (
              <button
                key={optionMode}
                ref={checked ? checkedRef : undefined}
                className={`${styles.roomFilterOption} ${styles.viewModeOption}${checked ? ` ${styles.roomFilterOptionActive}` : ''}`}
                role="menuitemradio"
                aria-checked={checked}
                // Arrow keys move between the items; Tab leaves the menu (and closes it, see onBlur).
                tabIndex={-1}
                title={hint}
                onClick={() => choose(optionMode)}
                type="button"
              >
                <Icon />
                <span className={styles.viewModeLabel}>{label}</span>
                <span className={styles.viewModeCheck}>{checked && <CheckIcon />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
