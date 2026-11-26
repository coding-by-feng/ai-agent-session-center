/**
 * ContextDetailsPopover — the card the header's model · effort · context chip opens
 * (Nov 25 2026): the context window, cache hit rates, the last reply's and the whole
 * session's tokens, Claude Code's reference cost, the session id and the terminal size.
 *
 * The last reply comes with the session (`runtime.context`); the totals, cost and terminal
 * size are read once when the card opens (`GET /api/sessions/:id/context-usage`).
 *
 * Portaled to `<body>` with `position: fixed`, placed under the chip, kept inside the
 * viewport (clamped sideways, flipped above when there is no room below). Esc, a press
 * outside it or a second click on the chip closes it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@/types';
import type { SessionUsageDetails } from '@/types/session';
import { contextDetailsView, fetchSessionUsage } from '@/lib/contextDetails';
import styles from '@/styles/modules/ContextDetails.module.css';

const VIEWPORT_MARGIN = 8;
const GAP = 6;
const COPIED_MS = 1500;

type UsageState = { sessionId: string; data: SessionUsageDetails | null; failed: boolean };

interface Props {
  session: Session;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  onClose: () => void;
}

function usePlacement(anchorRef: RefObject<HTMLElement | null>, cardRef: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const card = cardRef.current;
    if (!anchor || !card) return;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(vw - w - VIEWPORT_MARGIN, anchor.left));
    const below = anchor.bottom + GAP;
    const top = below + h <= vh - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, anchor.top - GAP - h);
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [anchorRef, cardRef]);
  return { pos, place };
}

export default function ContextDetailsPopover({ session, anchorRef, id, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { pos, place } = usePlacement(anchorRef, cardRef);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [copied, setCopied] = useState(false);
  const sessionId = session.sessionId;

  useEffect(() => {
    const ctrl = new AbortController();
    fetchSessionUsage(sessionId, ctrl.signal).then(
      (data) => setUsage({ sessionId, data, failed: false }),
      () => {
        if (!ctrl.signal.aborted) setUsage({ sessionId, data: null, failed: true });
      },
    );
    return () => ctrl.abort();
  }, [sessionId]);

  const current = usage?.sessionId === sessionId ? usage : null;
  const view = contextDetailsView(session, current?.data ?? null);

  // Re-placed whenever its height can change (the totals arriving) and on a resize.
  useLayoutEffect(() => {
    place();
  }, [place, current, view?.cells.length]);
  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [anchorRef, onClose]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const copyId = useCallback(() => {
    void navigator.clipboard?.writeText(sessionId).then(() => setCopied(true), () => undefined);
  }, [sessionId]);

  if (!view) return null;
  const loading = current === null;

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="dialog"
      aria-label="Context details"
      className={styles.card}
      // Measured invisible first, so it never flashes at the wrong spot.
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <div className={styles.head}>
        <span className={styles.model}>{view.model}</span>
        {view.steps && <span className={styles.muted}>{view.steps}</span>}
      </div>

      {view.context && (
        <>
          <div className={styles.usedRow}>
            <span className={styles.muted}>Context used</span>
            <span className={styles.usedValue}>
              {view.context.text}
              {view.context.estimated && (
                <span className={styles.estimate} title="Worked out from the token counts, not reported by the CLI">estimate</span>
              )}
            </span>
          </div>
          <div
            className={styles.bar}
            data-level={view.context.level}
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(view.context.pct)}
          >
            <div className={styles.barFill} style={{ width: `${view.context.pct}%` }} />
          </div>
        </>
      )}

      {(view.cells.length > 0 || loading || current?.failed) && (
        <div className={styles.section}>
          {view.cells.length > 0 && (
            <dl className={styles.grid}>
              {view.cells.map((c) => (
                <div key={c.label} className={styles.cell}>
                  <dt>{c.label}</dt>
                  <dd>
                    {c.value}
                    {c.detail && <span className={styles.detail}>{c.detail}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {loading && <div className={styles.note}>Reading the session totals…</div>}
          {current?.failed && <div className={styles.note}>Couldn’t read the session totals.</div>}
        </div>
      )}

      {view.cost && (
        <div className={styles.section}>
          <div className={styles.row}>
            <span className={styles.muted}>API reference cost</span>
            <span className={styles.cost}>{view.cost}</span>
          </div>
          <div className={styles.note}>
            What Claude Code reports at public API prices. Reference only, not your subscription bill.
          </div>
        </div>
      )}

      <div className={`${styles.section} ${styles.row}`}>
        <button type="button" className={styles.idButton} onClick={copyId} aria-label={`Copy session id ${sessionId}`}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {copied ? 'Copied' : `#${view.shortId}`}
        </button>
        {view.terminal && <span className={styles.muted}>Terminal {view.terminal}</span>}
      </div>
    </div>,
    document.body,
  );
}
