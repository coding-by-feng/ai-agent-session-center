/**
 * PlanUsageChip — the AI CLI's plan limits, at the top-left of the session
 * header: the CLI's mark, its most-used limit window, and how much of it is used.
 * Hovering or focusing it lists every window with its reset time.
 *
 * What it shows is the ACCOUNT's usage (`session.planUsage`: the server hands
 * every live session of one CLI the freshest report), not this session's — see
 * `lib/planUsage.ts` for what is shown and why.
 *
 * Things here that are easy to get wrong:
 *
 *  - It always renders for a Claude or Codex session, as "—" when there is
 *    nothing to show, so the title row does not jump when the first report
 *    arrives. A reason is in the tooltip and the aria-label.
 *  - It is a readout, not a button: no border, no hover fill. It has a tabindex
 *    only so the tooltip is reachable from the keyboard.
 *  - Its width is fixed per layout (see the CSS): a changing number must not push
 *    the status dot, the # chip and the title sideways.
 *  - The countdown ticks once a minute through a clock scoped to THIS component,
 *    so a switcher with fifty sessions does not re-render every minute for it.
 *  - Severity is the bar's colour AND a ▲ after the number from 85%; the text
 *    never changes colour, so contrast is the same in every theme.
 *
 * Two glyphs here are new to the app, and neither is what it already means
 * elsewhere: ↻ before the countdown says "this window renews" in read-only text
 * (it is NOT the refresh action PromptsView uses it for, nor the queue's loop ⟳);
 * ▲ after the number says "high usage" (it is NOT a trend or direction, nor the
 * filled disclosure triangle the fold toggles use).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { CLI_LAUNCHERS } from '@/components/layout/cliLaunchers';
import Tooltip from '@/components/ui/Tooltip';
import { detectCli } from '@/lib/cliDetect';
import { describePlanUsage, type PlanUsageRow, type PlanUsageView } from '@/lib/planUsage';
import type { Session } from '@/types';
import styles from '@/styles/modules/DetailPanel.module.css';

/** How often the countdown (and the "has this window reset yet?" check) refreshes. */
const CLOCK_TICK_MS = 60_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** `--pct` carries the percentage to the stylesheet, which draws the bar from it. */
const pctStyle = (usedPercent: number): CSSProperties => ({ '--pct': `${usedPercent}%` }) as CSSProperties;

function TipRow({ row }: { row: PlanUsageRow }) {
  return (
    <div className={styles.planUsageTipRow} data-severity={row.severity}>
      <span className={styles.planUsageTipName}>{row.name}</span>
      <span className={styles.planUsageTipBar} style={pctStyle(row.usedPercent)} aria-hidden="true">
        <span className={styles.planUsageTipFill} />
      </span>
      <span className={styles.planUsageTipPercent}>{row.percentText}</span>
      {row.resetAtText && (
        <span className={styles.planUsageTipReset}>
          resets {row.resetAtText}
          {row.resetIsCountdown && row.resetInText ? ` (in ${row.resetInText})` : ''}
        </span>
      )}
    </div>
  );
}

function TipBody({ view }: { view: PlanUsageView }) {
  return (
    <div className={styles.planUsageTip}>
      {view.rows.length === 0 && view.reason && <p className={styles.planUsageTipNote}>{view.reason}</p>}
      {view.rows.map((row, i) => (
        // Two windows of one length are not expected, but a repeated key would only warn, never help.
        <TipRow key={`${row.minutes}:${i}`} row={row} />
      ))}
      {view.limitReached && <p className={styles.planUsageTipAlert}>Limit reached</p>}
      {view.asOf && <p className={styles.planUsageTipNote}>as of {view.asOf}</p>}
    </div>
  );
}

export default function PlanUsageChip({ session }: { session: Session }) {
  const now = useNow(CLOCK_TICK_MS);
  const usage = session.planUsage ?? null;
  const cli = usage?.cli ?? detectCli(session);
  if (!cli) return null;

  const view = describePlanUsage(cli, usage, now);
  const { headline } = view;
  const Mark = CLI_LAUNCHERS.find((l) => l.command === cli)?.Icon;

  return (
    <span className={styles.planUsageSlot}>
      <Tooltip label={view.tooltipTitle} content={<TipBody view={view} />} placement="bottom">
        <span
          className={styles.planUsageChip}
          role="group"
          tabIndex={0}
          aria-label={view.ariaLabel}
          data-cli={cli}
          data-state={view.state}
          data-severity={view.severity}
          // Stale is a property of a figure on show: a dash has none to be out of date.
          data-stale={headline && view.stale ? 'true' : 'false'}
        >
          {Mark && (
            <span className={styles.planUsageMark} aria-hidden="true">
              <Mark size={13} />
            </span>
          )}
          {headline ? (
            <>
              <span className={styles.planUsageWindow}>{headline.label}</span>
              <span className={styles.planUsageBar} style={pctStyle(headline.usedPercent)} aria-hidden="true">
                <span className={styles.planUsageFill} />
              </span>
              <span className={styles.planUsageValue}>
                {headline.percentText}
                {view.severity === 'high' && (
                  <span className={styles.planUsageAlert} aria-hidden="true">
                    ▲
                  </span>
                )}
              </span>
              {headline.resetInText && (
                <span className={styles.planUsageReset} aria-hidden="true">
                  ↻ {headline.resetInText}
                </span>
              )}
            </>
          ) : (
            <span className={styles.planUsageValue}>—</span>
          )}
        </span>
      </Tooltip>
    </span>
  );
}
