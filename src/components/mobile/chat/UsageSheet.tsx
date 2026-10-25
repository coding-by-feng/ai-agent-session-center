/**
 * UsageSheet — what the composer's usage chip opens (Oct 20 2026): this session's
 * context window, then the account's plan limits (5-hour, weekly), each with a meter,
 * when it resets and how old the reading is. Claude Code and Codex alike.
 *
 * The Context window card opens to its details when the CLI reported more than the %
 * (Oct 21 2026): free space, the last reply's tokens by kind, how old the reading is. Opened,
 * it also asks the Mac what fills the window (Oct 22 2026): tokens by type with their share,
 * and the largest items, measured from the transcript (GET …/context-breakdown).
 *
 * Read-only: the figures come with the session (`runtime.context`, `planUsage`) as the
 * Mac reads them; a phone has nothing to sync. The plan section names the account: two
 * sessions showing the same 42% is the point, not a bug.
 */
import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { Session } from '@/types';
import { Sheet } from '../kit';
import { describeContextBreakdown, describeUsage, type UsageContext, type UsageContextDetails } from '@/lib/chat/usageModel';
import { fetchContextBreakdown, type ApiResult } from '@/lib/chat/chatApi';
import type { ContextBreakdown } from '@/types/chat';
import { ChevronRightIcon } from '../kit/kitIcons';
import type { PlanUsageSeverity } from '@/lib/planUsage';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

const DETENTS = ['medium', 'large'] as const;
/** The countdowns move by the minute; the sheet re-reads the clock this often while open. */
const TICK_MS = 30_000;

type Level = PlanUsageSeverity;
const CLI_SHORT = { claude: 'Claude', codex: 'Codex' } as const;

function Meter({ pct, level }: { pct: number; level: Level }) {
  return (
    <span className={styles.usageMeter} aria-hidden="true">
      {/* The fill's width rides a custom property, as ChatFooter's height does. */}
      <span className={styles.usageMeterFill} data-level={level} style={{ '--usage-pct': `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties} />
    </span>
  );
}

function UsageRow({ name, pctText, high, pct, level, detail }: {
  name: string; pctText: string; high: boolean; pct: number; level: Level; detail: string | null;
}) {
  return (
    <div className={styles.usageRow}>
      <div className={styles.usageHead}>
        <span>{name}</span>
        <span className={styles.usagePct}>
          {pctText}
          {high && <><span aria-hidden="true"> ▲</span><span className={styles.srOnly}>, high</span></>}
        </span>
      </div>
      <Meter pct={pct} level={level} />
      {detail && <p className={styles.usageDetail}>{detail}</p>}
    </div>
  );
}

/**
 * What fills the window, asked of the Mac while the card is open; asked again when a new
 * reading arrives (`contextAt`). The last answer stays up while the next one loads.
 */
function WindowBreakdown({ sessionId, contextAt, size, now }: {
  sessionId: string; contextAt: number | undefined; size: number | undefined; now: number;
}) {
  const [result, setResult] = useState<ApiResult<ContextBreakdown | null> | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchContextBreakdown(sessionId, ctrl.signal).then(setResult, () => {});
    return () => ctrl.abort();
  }, [sessionId, contextAt]);

  if (!result) return <p className={styles.usageDetail}>Measuring what fills it…</p>;
  if (!result.ok) return <p className={styles.usageDetail}>{result.message}</p>;
  if (!result.data) return <p className={styles.usageDetail}>What fills the window is measured for Claude Code sessions only.</p>;
  const view = describeContextBreakdown(result.data, size, now);
  return (
    <>
      <h4 className={styles.usageSubheading}>What’s in it</h4>
      <ul className={styles.usageKinds} aria-label="What fills the context window">
        {view.rows.map((r) => (
          <li key={r.key} className={styles.usageKind}>
            <span className={styles.usageKindHead}>
              <span className={styles.usageKindLabel}>{r.label}</span>
              <span className={styles.usageKindValue}>{r.tokensText} · {r.pctText}</span>
            </span>
            <span className={styles.usageKindBar} aria-hidden="true">
              <span className={styles.usageKindFill} data-free={r.key === 'free' ? '' : undefined} style={{ '--usage-pct': `${Math.max(0, Math.min(100, r.pct))}%` } as CSSProperties} />
            </span>
          </li>
        ))}
      </ul>
      {view.items.length > 0 && (
        <>
          <h4 className={styles.usageSubheading}>Largest items</h4>
          <dl className={styles.usageParts} aria-label="Largest items in the context window">
            {view.items.map((item) => (
              <div key={item.key} className={styles.usagePart}>
                <dt className={styles.usageItemLabel}>{item.label}</dt>
                <dd>{item.tokensText}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className={styles.usageDetail}>{view.note}</p>
    </>
  );
}

/** The Context window card, as a button that opens its details below it. */
function ContextRow({ context, details, session, now }: {
  context: UsageContext; details: UsageContextDetails; session: Session; now: number;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const hasOutput = details.rows.some((r) => r.label === 'Last reply’s output');
  return (
    <div className={styles.usageRow}>
      <button
        type="button"
        className={styles.usageRowButton}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.usageHead}>
          <span>Context window</span>
          <span className={styles.usagePct}>
            {context.pctText}
            {context.level === 'high' && <><span aria-hidden="true"> ▲</span><span className={styles.srOnly}>, high</span></>}
            <ChevronRightIcon className={styles.usageChevron} data-open={open ? '' : undefined} aria-hidden="true" />
          </span>
        </span>
        <Meter pct={context.pct} level={context.level} />
        {context.tokensText && <span className={styles.usageDetail}>{context.tokensText}</span>}
      </button>
      {open && (
        <section id={detailsId} className={styles.usageMore} aria-label="Context window details">
          <WindowBreakdown
            sessionId={session.sessionId}
            contextAt={session.runtime?.contextAt}
            size={session.runtime?.context?.size}
            now={now}
          />
          <h4 className={styles.usageSubheading}>Last reply, as reported</h4>
          {details.freeText && <p className={styles.usageDetail}>{details.freeText}</p>}
          {details.rows.length > 0 && (
            <dl className={styles.usageParts}>
              {details.rows.map((r) => (
                <div key={r.label} className={styles.usagePart}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {hasOutput && <p className={styles.usageDetail}>The last reply’s output joins the window with the next turn.</p>}
          {details.reportedText && <p className={styles.usageDetail}>{details.reportedText}</p>}
        </section>
      )}
    </div>
  );
}

export interface UsageSheetProps {
  open: boolean;
  onClose: () => void;
  session: Session;
}

export default function UsageSheet({ open, onClose, session }: UsageSheetProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  const { context, contextDetails, plan } = describeUsage(session, now);
  const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <Sheet open={open} onClose={onClose} title="Usage" detents={DETENTS} testId="usage-sheet">
      <section className={styles.usageSection} aria-label="This session">
        <h3 className={styles.usageHeading}>This session</h3>
        {context && contextDetails ? (
          <ContextRow context={context} details={contextDetails} session={session} now={now} />
        ) : context ? (
          <UsageRow
            name="Context window"
            pctText={context.pctText}
            high={context.level === 'high'}
            pct={context.pct}
            level={context.level}
            detail={context.tokensText}
          />
        ) : (
          <p className={styles.usageEmpty}>Not reported yet: it appears after the agent’s next reply.</p>
        )}
      </section>

      {plan && (
        <section className={styles.usageSection} aria-label={`${plan.cliName} plan`}>
          <h3 className={styles.usageHeading}>{plan.cliName} plan{plan.plan ? ` · ${plan.plan}` : ''} · your account</h3>
          {plan.limitReached && <p className={styles.usageAlert} role="note">▲ A limit has been reached.</p>}
          {plan.state === 'ready'
            ? plan.rows.map((r) => (
              <UsageRow
                key={r.minutes}
                name={`${sentenceCase(r.name)} limit`}
                pctText={r.percentText}
                high={r.severity === 'high'}
                pct={r.usedPercent}
                level={r.severity}
                detail={r.resetsAt == null ? null : r.resetIsCountdown ? `Resets in ${r.resetInText} · at ${r.resetAtText}` : `Resets ${r.resetAtText}`}
              />
            ))
            : <p className={styles.usageEmpty}>{plan.reason}</p>}
          {plan.sourceNote && (
            <p className={styles.usageNote}>
              Shared by every {CLI_SHORT[plan.cli]} session on this account. {plan.sourceNote}
              {plan.asOfAge ? `, updated ${plan.asOfAge}` : ''}{plan.stale ? ' (an old reading)' : ''}.
            </p>
          )}
        </section>
      )}
    </Sheet>
  );
}
