/**
 * ContextDetailsPopover — the card the header's model · effort · context chip opens
 * (Nov 25 2026), in labelled sections (Nov 27 2026):
 *   WINDOW       how full, how much is free
 *   WHAT'S IN IT the window by kind, each opening to its largest entries (`ContextBreakdownList`)
 *   TOKENS       the last reply's and the whole session's input / output, cache hit rates
 *   COST         Claude Code's reference cost
 *   SESSION      the session id (copies) and the terminal size
 *
 * The last reply comes with the session (`runtime.context`); the totals, cost and terminal
 * size (`GET /api/sessions/:id/context-usage`) and the breakdown (`…/context-breakdown`) are
 * read in parallel when the card opens, each with its own loading and failed line.
 *
 * Portaled to `<body>` with `position: fixed`, placed under the chip, kept inside the
 * viewport: clamped sideways, flipped above when there is no room below, and when it fits
 * neither way, given the larger side and scrolled inside. Esc, a press outside it or a
 * second click on the chip closes it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@/types';
import type { SessionUsageDetails } from '@/types/session';
import { contextDetailsView, fetchSessionUsage, placeCard, type CardPlacement } from '@/lib/contextDetails';
import ContextBreakdownList from './ContextBreakdownList';
import styles from '@/styles/modules/ContextDetails.module.css';

const COPIED_MS = 1500;

type UsageState = { sessionId: string; data: SessionUsageDetails | null; failed: boolean };

interface Props {
  session: Session;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  onClose: () => void;
}

function usePlacement(anchorRef: RefObject<HTMLElement | null>, cardRef: RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<CardPlacement | null>(null);
  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const card = cardRef.current;
    if (!anchor || !card) return;
    const border = card.offsetHeight - card.clientHeight;
    const next = placeCard(
      anchor,
      { width: card.offsetWidth, naturalHeight: card.scrollHeight + border },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((p) => (p && p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next));
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

  // Re-placed whenever its height can change (totals or the breakdown arriving, a kind opened)
  // and on a resize.
  useLayoutEffect(() => {
    place();
  }, [place, current, view?.tokens.length]);
  useEffect(() => {
    window.addEventListener('resize', place);
    const card = cardRef.current;
    const observer = card && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
    if (card && observer) {
      for (const child of Array.from(card.children)) observer.observe(child);
    }
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
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
  const totalsNote = loading
    ? 'Reading the session totals…'
    : current?.failed ? 'Couldn’t read the session totals.' : null;

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="dialog"
      aria-label="Context details"
      className={styles.card}
      // Measured invisible first, so it never flashes at the wrong spot.
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <div className={styles.head}>
        <span className={styles.model}>{view.effort ? `${view.model} · ${view.effort}` : view.model}</span>
        {view.steps && <span className={styles.muted}>{view.steps}</span>}
      </div>

      <section className={styles.block} aria-label="Window">
        <h3 className={styles.heading}>Window</h3>
        {view.context ? (
          <>
            <div className={styles.usedRow}>
              <span className={styles.usedValue}>
                {view.context.text}
                {view.context.estimated && (
                  <span className={styles.estimate} title="Worked out from the token counts, not reported by the CLI">estimate</span>
                )}
              </span>
              {view.context.free && <span className={styles.muted}>{view.context.free}</span>}
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
        ) : (
          <p className={styles.note}>Not reported yet: it arrives with the next reply.</p>
        )}
      </section>

      <section className={styles.block} aria-label="What’s in it">
        <h3 className={styles.heading}>What’s in it</h3>
        <ContextBreakdownList sessionId={sessionId} contextAt={session.runtime?.contextAt} />
      </section>

      {(view.tokens.length > 0 || totalsNote) && (
        <section className={styles.block} aria-label="Tokens">
          <h3 className={styles.heading}>Tokens</h3>
          {view.tokens.length > 0 && (
            <table className={styles.tokens}>
              <thead>
                <tr>
                  <td />
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                </tr>
              </thead>
              <tbody>
                {view.tokens.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td>
                      {r.input}
                      {r.detail && <span className={styles.detail}>{r.detail}</span>}
                    </td>
                    <td>{r.output ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view.cacheHit && (
            <div className={styles.row}>
              <span className={styles.muted}>Cache hit</span>
              <span className={styles.mono}>{view.cacheHit}</span>
            </div>
          )}
          {totalsNote && <p className={styles.note}>{totalsNote}</p>}
        </section>
      )}

      {view.cost && (
        <section className={styles.block} aria-label="Cost">
          <h3 className={styles.heading}>Cost</h3>
          <div className={styles.row}>
            <span className={styles.muted}>API reference cost</span>
            <span className={styles.cost}>{view.cost}</span>
          </div>
          <p className={styles.note}>
            What Claude Code reports at public API prices. Reference only, not your subscription bill.
          </p>
        </section>
      )}

      <section className={styles.block} aria-label="Session">
        <h3 className={styles.heading}>Session</h3>
        <div className={styles.row}>
          <button type="button" className={styles.idButton} onClick={copyId} aria-label={`Copy session id ${sessionId}`}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {copied ? 'Copied' : `#${view.shortId}`}
          </button>
          {view.terminal && <span className={styles.muted}>Terminal {view.terminal}</span>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
