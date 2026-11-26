/**
 * ContextBreakdownList — the WHAT'S IN IT section of the header's Context details card
 * (Nov 27 2026): what fills the session's context window, by kind with its share of the
 * window, each kind opening to its largest entries; then the largest single items.
 *
 * The same measurement and wording as the phone's Usage sheet (`describeContextBreakdown`,
 * `GET /api/sessions/:id/context-breakdown`). Asked once when the card opens and again when a
 * new reading arrives (`contextAt`); the last answer stays up while the next one loads.
 *
 * Shares are of what is IN the window, not of its size (unlike the phone, which lists Free as a
 * row): against a 1M window every bar was a sliver ("File reads 61k · 6%") and said nothing the
 * card's WINDOW bar doesn't. So no Free row here either; the WINDOW line says what is free.
 */
import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { ContextBreakdown } from '@/types/chat';
import { describeContextBreakdown, type ContextKindRow } from '@/lib/chat/usageModel';
import { fetchWindowBreakdown } from '@/lib/contextDetails';
import styles from '@/styles/modules/ContextDetails.module.css';

type Result =
  | { sessionId: string; state: 'ready'; data: ContextBreakdown | null; at: number }
  | { sessionId: string; state: 'failed' };

interface Props {
  sessionId: string;
  /** When the session's last context reading arrived: a new one asks again. */
  contextAt: number | undefined;
}

function KindHead({ row }: { row: ContextKindRow }) {
  return (
    <>
      <span className={styles.kindLabel}>{row.label}</span>
      <span className={styles.kindValue}>{row.tokensText}</span>
      <span className={styles.kindBar} aria-hidden="true">
        <span className={styles.kindFill} style={{ '--kind-pct': `${Math.max(0, Math.min(100, row.pct))}%` } as CSSProperties} />
      </span>
      <span className={styles.kindPct}>{row.pctText}</span>
    </>
  );
}

function KindRow({ row, open, onToggle }: { row: ContextKindRow; open: boolean; onToggle: () => void }) {
  const entriesId = useId();
  if (row.entries.length === 0 && row.note === null) {
    return (
      <li className={styles.kind}>
        <span className={styles.kindStatic}>
          <span aria-hidden="true" />
          <KindHead row={row} />
        </span>
      </li>
    );
  }
  return (
    <li className={styles.kind}>
      <button type="button" className={styles.kindButton} aria-expanded={open} aria-controls={entriesId} onClick={onToggle}>
        <svg className={styles.chevron} data-open={open ? '' : undefined} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <KindHead row={row} />
      </button>
      {open && (
        <div id={entriesId} className={styles.entries}>
          {row.entries.length > 0 ? (
            <ul className={styles.entryList} aria-label={`In ${row.label}`}>
              {row.entries.map((e) => (
                <li key={e.key} className={styles.entry}>
                  <span className={styles.entryLabel} title={e.label}>{e.label}</span>
                  {e.countText && <span className={styles.entryCount}>{e.countText}</span>}
                  <span className={styles.entryValue}>{e.tokensText}</span>
                </li>
              ))}
              {row.rest && (
                <li className={styles.entry} data-rest="">
                  <span className={styles.entryLabel}>{row.rest.label}</span>
                  <span className={styles.entryValue}>{row.rest.tokensText}</span>
                </li>
              )}
            </ul>
          ) : (
            <p className={styles.note}>{row.note}</p>
          )}
        </div>
      )}
    </li>
  );
}

export default function ContextBreakdownList({ sessionId, contextAt }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  /** The one kind opened to its entries. */
  const [openKind, setOpenKind] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchWindowBreakdown(sessionId, ctrl.signal).then(
      (data) => setResult({ sessionId, state: 'ready', data, at: Date.now() }),
      () => {
        if (!ctrl.signal.aborted) setResult({ sessionId, state: 'failed' });
      },
    );
    return () => ctrl.abort();
  }, [sessionId, contextAt]);

  const current = result?.sessionId === sessionId ? result : null;
  if (!current) return <p className={styles.note}>Measuring what fills the window…</p>;
  if (current.state === 'failed') return <p className={styles.note}>Couldn’t read what fills the window.</p>;
  // The card opens for Claude sessions only (Codex has no chip), so null is a transcript with no request yet.
  if (!current.data) return <p className={styles.note}>Nothing to measure yet: it arrives after the first reply.</p>;

  // No size: shares of what is in the window, and no Free row.
  const view = describeContextBreakdown(current.data, undefined, current.at);
  return (
    <>
      <ul className={styles.kinds} aria-label="What fills the context window">
        {view.rows.map((r) => (
          <KindRow key={r.key} row={r} open={openKind === r.key} onToggle={() => setOpenKind((k) => (k === r.key ? null : r.key))} />
        ))}
      </ul>
      {view.items.length > 0 && (
        <>
          <h4 className={styles.subheading}>Largest items</h4>
          <dl className={styles.items} aria-label="Largest items in the context window">
            {view.items.map((item) => (
              <div key={item.key} className={styles.item}>
                <dt title={item.label}>{item.label}</dt>
                <dd>{item.tokensText}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className={styles.note}>{view.note}</p>
    </>
  );
}
