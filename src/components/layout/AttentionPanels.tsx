/**
 * AttentionPanels — the bell's list and its hint (Nov 26 2026). Both are portaled to <body> as `position: fixed`,
 * hang under the bell right-aligned, and are clamped inside the viewport (see DevicePresenceChip for why a header
 * popover must be portaled). An alert's text was written by an agent: it is only ever rendered as text.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { waitAge, type Hint, type WaitItem, type WaitKind } from '@/lib/attentionInbox';
import styles from '@/styles/modules/AttentionBell.module.css';

const VIEWPORT_PAD = 8;
const LIST_WIDTH = 380;
const HINT_WIDTH = 340;

const GLYPH: Record<WaitKind, string> = { question: '?', approval: '!', proceed: 'P', alert: '⚠' };
const GLYPH_CLASS: Record<WaitKind, string> = {
  question: styles.glyphQuestion,
  approval: styles.glyphApproval,
  proceed: styles.glyphProceed,
  alert: styles.glyphAlert,
};

/**
 * Hangs `panel` under `anchor`, right-aligned to it and kept inside the viewport, before it paints; again on scroll
 * and resize. Written to the panel's own style, so placing it never re-renders.
 */
function useAnchoredPlacement(anchor: RefObject<HTMLElement | null>, wanted: number): RefObject<HTMLDivElement | null> {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = anchor.current;
      const box = panel.current;
      if (!el || !box) return;
      const rect = el.getBoundingClientRect();
      const width = Math.min(wanted, window.innerWidth - VIEWPORT_PAD * 2);
      const left = Math.min(Math.max(VIEWPORT_PAD, rect.right - width), window.innerWidth - width - VIEWPORT_PAD);
      box.style.top = `${rect.bottom + 6}px`;
      box.style.left = `${Math.max(VIEWPORT_PAD, left)}px`;
      box.style.width = `${width}px`;
      box.style.visibility = 'visible';
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, wanted]);
  return panel;
}

function Glyph({ kind }: { kind: WaitKind }) {
  return <span className={`${styles.glyph} ${GLYPH_CLASS[kind]}`} aria-hidden="true">{GLYPH[kind]}</span>;
}

/**
 * What waits, then when. A central's alert is its own words, so it gets two lines and the age goes under it; the
 * fixed details share one line with the age. Either way the age (and the hint's "+N more") never ellipsises away.
 */
function Detail({ item, meta }: { item: WaitItem; meta: string }) {
  const stacked = item.kind === 'alert';
  return (
    <span className={`${styles.rowDetail} ${stacked ? styles.rowDetailStacked : ''}`}>
      <span className={stacked ? styles.detailClamp : styles.detailText} title={item.detail}>{item.detail}</span>
      {meta ? <span className={styles.rowMeta}>{stacked ? meta : `· ${meta}`}</span> : null}
    </span>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

interface ListProps {
  anchor: RefObject<HTMLElement | null>;
  items: WaitItem[];
  onOpen: (item: WaitItem) => void;
  onDismiss: (item: WaitItem) => void;
  onClose: (refocus: boolean) => void;
}

export function AttentionList({ anchor, items, onOpen, onDismiss, onClose }: ListProps) {
  const panelRef = useAnchoredPlacement(anchor, LIST_WIDTH);
  const [now, setNow] = useState(() => Date.now());

  // Ages move on while the list is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose(true);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, panelRef, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Waiting on you"
      className={styles.panel}
    >
      {items.length === 0 ? (
        <p className={styles.empty}>Nothing waiting on you</p>
      ) : (
        <>
        <div className={styles.panelHead}>Waiting on you ({items.length})</div>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.key} className={styles.row}>
              <Glyph kind={item.kind} />
              <div className={styles.rowMain}>
                <span className={styles.rowTitle} title={item.title}>{item.title}</span>
                <Detail item={item} meta={[item.from ? `from ${item.from}` : '', waitAge(item.since, now)].filter(Boolean).join(' · ')} />
              </div>
              <button type="button" className={styles.openBtn} onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
                Open
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => onDismiss(item)}
                aria-label={`${item.alertId ? 'Dismiss' : 'Hide'} ${item.title}`}
                title={item.alertId ? 'Dismiss this alert' : 'Hide until it next needs you'}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>,
    document.body,
  );
}

interface HintProps {
  anchor: RefObject<HTMLElement | null>;
  hint: Hint;
  onOpen: (item: WaitItem) => void;
  onClose: () => void;
  /** Hovering holds the hint on screen. */
  onHold: (held: boolean) => void;
}

export function AttentionHint({ anchor, hint, onOpen, onClose, onHold }: HintProps) {
  const hintRef = useAnchoredPlacement(anchor, HINT_WIDTH);
  const { item, more } = hint;
  return createPortal(
    <div
      ref={hintRef}
      role="status"
      className={styles.hint}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
    >
      <Glyph kind={item.kind} />
      <span className={styles.hintText}>
        <span className={styles.rowTitle} title={item.title}>{item.title}</span>
        <Detail item={item} meta={more > 0 ? `+${more} more` : ''} />
      </span>
      <button type="button" className={styles.openBtn} onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
        Open
      </button>
      <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close hint" title="Close">
        <CloseIcon />
      </button>
    </div>,
    document.body,
  );
}
