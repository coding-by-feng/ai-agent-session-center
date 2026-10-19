/**
 * UsageSheet — what the composer's usage chip opens (Oct 20 2026): this session's
 * context window, then the account's plan limits (5-hour, weekly), each with a meter,
 * when it resets and how old the reading is. Claude Code and Codex alike.
 *
 * Read-only: the figures come with the session (`runtime.context`, `planUsage`) as the
 * Mac reads them; a phone has nothing to sync. The plan section names the account: two
 * sessions showing the same 42% is the point, not a bug.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { Session } from '@/types';
import { Sheet } from '../kit';
import { describeUsage } from '@/lib/chat/usageModel';
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

  const { context, plan } = describeUsage(session, now);
  const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <Sheet open={open} onClose={onClose} title="Usage" detents={DETENTS} testId="usage-sheet">
      <section className={styles.usageSection} aria-label="This session">
        <h3 className={styles.usageHeading}>This session</h3>
        {context ? (
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
