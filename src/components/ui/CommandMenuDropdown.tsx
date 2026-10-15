/**
 * The `/` · `$` · `@` suggestion list, portaled to <body> at fixed viewport
 * coordinates the caller computes. Shared by `AutocompleteTextarea` (prompt
 * editors) and `TerminalCommandMenu` (a session's terminal) so the two look
 * and read the same.
 *
 * Portaled because an ancestor with a `filter` / `transform` / `backdrop-filter`
 * re-scopes `position: fixed` to its own box (see AutocompleteTextarea's note).
 * The whole box takes `mousedown` with `preventDefault()` (rows, headers, its
 * scrollbar) so the text field or terminal underneath keeps focus: a blur
 * closes the list.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CommandMenuItem, CommandMenuGroupSpan } from '@/lib/commandMenu';
import styles from '@/styles/modules/AutocompleteTextarea.module.css';

interface CommandMenuDropdownProps {
  items: CommandMenuItem[];
  groups?: CommandMenuGroupSpan[];
  selectedIdx: number;
  /** Fixed-position box: left/width/maxHeight and one of top/bottom. */
  style: React.CSSProperties;
  onPick: (item: CommandMenuItem) => void;
  /** Right side of the footer: the keys this surface accepts. */
  keysHint: string;
  ariaLabel?: string;
}

export default function CommandMenuDropdown({
  items,
  groups,
  selectedIdx,
  style,
  onPick,
  keysHint,
  ariaLabel = 'Suggestions',
}: CommandMenuDropdownProps) {
  const selectedRef = useRef<HTMLDivElement | null>(null);

  // Keep the highlighted row in view as ↑/↓ walk a list longer than the box.
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIdx]);

  const headerAt = new Map<number, string>();
  for (const g of groups ?? []) headerAt.set(g.startIdx, g.title);

  return createPortal(
    <div
      className={styles.acDropdown}
      style={style}
      role="listbox"
      aria-label={ariaLabel}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={`row-${i}-${item.insert}`}>
          {headerAt.has(i) && <div className={styles.acGroupHeader}>{headerAt.get(i)}</div>}
          <div
            ref={i === selectedIdx ? selectedRef : undefined}
            role="option"
            aria-selected={i === selectedIdx}
            className={`${styles.acItem}${i === selectedIdx ? ` ${styles.acItemSelected}` : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
          >
            {item.kind && (
              <span className={styles.acKindIcon}>
                {item.kind === 'skill' ? '★' : item.kind === 'file' ? '@' : '▸'}
              </span>
            )}
            <span className={styles.acLabel}>{item.label}</span>
            {item.fav && <span className={styles.acFav} role="img" aria-label="Favourite" title="Favourite">♥</span>}
            {item.abbr && <span className={styles.acAbbr} title={`Abbreviation: ${item.abbr}`}>{item.abbr}</span>}
            {item.hint && <span className={styles.acHint} title={item.hint}>{item.hint}</span>}
            {item.sub && <span className={styles.acSub}>{item.sub}</span>}
          </div>
        </div>
      ))}
      <div className={styles.acFooter}>
        <span>
          {items.length} match{items.length === 1 ? '' : 'es'}
        </span>
        <span>{keysHint}</span>
      </div>
    </div>,
    document.body,
  );
}
