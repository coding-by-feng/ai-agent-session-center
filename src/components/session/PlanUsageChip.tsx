/**
 * PlanUsageChip — the AI CLI's plan limits, at the top-left of the session
 * header: the CLI's mark, its most-used limit window, and how much of it is used.
 * Hovering or focusing it lists every window with its reset time, how old the
 * reading is, and what the last sync found. Clicking it syncs.
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
 *  - It is a button: a click asks the server to re-read the CLI's usage files now
 *    (`useSyncPlanUsage`). The numbers are still the last reply's, so a sync can end
 *    the dashboard's own delay but not claude.ai's; the panel says how old the
 *    reading is and whether the sync found anything newer, so the rest of the delay
 *    is visible instead of mysterious. While it works it is `aria-busy`, never
 *    `disabled`: a button that disables itself drops keyboard focus.
 *  - The outcome is a status line in the PANEL (hover) and a visually-hidden live
 *    region (screen readers); a failure is also a toast, in the hook. The panel is
 *    a tooltip and takes no pointer, so it cannot hold the button itself.
 *  - Its width is fixed per layout (see the CSS): a changing number must not push
 *    the status dot, the # chip and the title sideways.
 *  - The countdown ticks once a minute through a clock scoped to THIS component,
 *    so a switcher with fifty sessions does not re-render every minute for it.
 *  - Severity is the bar's colour AND a ▲ after the number from 85%; the text
 *    never changes colour, so contrast is the same in every theme.
 *
 * Two glyph decisions: the reset time wears a CLOCK, not ↻ — the arrow is the sync
 * action's now, and the chip must not carry two meanings for it (the app's other
 * ↻, PromptsView's, also means refresh); ▲ after the number says "high usage" (it is
 * NOT a trend or direction, nor the filled disclosure triangle the fold toggles use).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { CLI_LAUNCHERS } from '@/components/layout/cliLaunchers';
import Tooltip from '@/components/ui/Tooltip';
import { useSyncPlanUsage } from '@/hooks/useSyncPlanUsage';
import { detectCli } from '@/lib/cliDetect';
import {
  describePlanUsage,
  describeSync,
  type PlanUsageRow,
  type PlanUsageSyncNote,
  type PlanUsageView,
} from '@/lib/planUsage';
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

/** The reset time's mark: a clock, because the arrow now means "sync". */
function ClockIcon() {
  return (
    <svg
      className={styles.planUsageResetIcon}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="5" r="4" />
      <path d="M5 2.8V5l1.5 1" />
    </svg>
  );
}

/** A circular arrow: what takes the CLI mark's place while a sync is in flight. */
function SpinnerIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

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

function TipBody({ view, note }: { view: PlanUsageView; note: PlanUsageSyncNote }) {
  return (
    <div className={styles.planUsageTip}>
      {view.rows.length === 0 && view.reason && <p className={styles.planUsageTipNote}>{view.reason}</p>}
      {view.rows.map((row, i) => (
        // Two windows of one length are not expected, but a repeated key would only warn, never help.
        <TipRow key={`${row.minutes}:${i}`} row={row} />
      ))}
      {view.limitReached && <p className={styles.planUsageTipAlert}>Limit reached</p>}
      {view.asOf && (
        <p className={styles.planUsageTipNote}>
          as of {view.asOf}
          {view.asOfAge ? ` · ${view.asOfAge}` : ''}
        </p>
      )}
      {view.sourceNote && <p className={styles.planUsageTipNote}>{view.sourceNote}</p>}
      <p className={styles.planUsageTipSync} data-tone={note.tone}>
        <span className={styles.planUsageTipSyncGlyph} aria-hidden="true">
          {note.glyph}
        </span>
        <span>{note.text}</span>
      </p>
    </div>
  );
}

export default function PlanUsageChip({ session }: { session: Session }) {
  const now = useNow(CLOCK_TICK_MS);
  const usage = session.planUsage ?? null;
  const cli = usage?.cli ?? detectCli(session);
  const { state: syncState, sync } = useSyncPlanUsage(cli ?? null);
  if (!cli) return null;

  const view = describePlanUsage(cli, usage, now);
  const note = describeSync(syncState, now);
  const syncing = syncState.status === 'syncing';
  const { headline } = view;
  const Mark = CLI_LAUNCHERS.find((l) => l.command === cli)?.Icon;

  return (
    <span className={styles.planUsageSlot}>
      <Tooltip label={view.tooltipTitle} content={<TipBody view={view} note={note} />} placement="bottom">
        <button
          type="button"
          className={styles.planUsageChip}
          // The reason for a dash already ends in a full stop: one, not two, before the action.
          aria-label={`${view.ariaLabel.replace(/\.$/, '')}. Sync now.`}
          aria-busy={syncing}
          onClick={sync}
          data-cli={cli}
          data-state={view.state}
          data-severity={view.severity}
          // Stale is a property of a figure on show: a dash has none to be out of date.
          data-stale={headline && view.stale ? 'true' : 'false'}
          data-sync={syncState.status}
          data-syncing={syncing ? 'true' : undefined}
        >
          {syncing ? (
            <span className={styles.planUsageSpinner} aria-hidden="true">
              <SpinnerIcon />
            </span>
          ) : (
            Mark && (
              <span className={styles.planUsageMark} aria-hidden="true">
                <Mark size={13} />
              </span>
            )
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
                  <ClockIcon />
                  {headline.resetInText}
                </span>
              )}
            </>
          ) : (
            <span className={styles.planUsageValue}>—</span>
          )}
        </button>
      </Tooltip>
      <span className={styles.planUsageLive} role="status">
        {note.spoken}
      </span>
    </span>
  );
}
