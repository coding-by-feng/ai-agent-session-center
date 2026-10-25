/**
 * The held-queue notice: why the queue is not sending (the user stopped the last turn, subagents or background
 * shells are still running, or its CLI has not reported that it started), and the one action that fits.
 *
 * "It is ready — send anyway" is offered only in the window that fires the queue (Ruling P4-57): a release lives in
 * this window's store, so any other window — the queue float, a phone, a device without the workspace baton — could
 * only click a button that does nothing. There the banner says where to release it.
 */
import { useCallback } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import type { QueueHold } from '@/lib/queueScheduler';
import { useStartReleaseStore, useIsReleaseWindow } from '@/stores/startReleaseStore';
import styles from '@/styles/modules/Terminal.module.css';

interface Props {
  hold: QueueHold;
  sessionId: string;
  /** The card a release is tied to (session id + terminal). */
  card: { sessionId: string; terminalId: string | null } | undefined;
  runningSubagents?: number;
  runningBackground?: number;
}

const btnClass = `${styles.queueAutoSendBannerBtn} ${styles.queueHoldBannerBtn}`;

function holdText(hold: QueueHold, runningSubagents: number, runningBackground: number): string {
  switch (hold) {
    case 'not-started':
      return '⏳ Waiting for the session to report that it started. If it shows a question, such as trusting its folder, answer it in the terminal. Nothing sends until it reports in, or you say it is ready.';
    case 'cancelled':
      return '⏸ Paused — you stopped the last turn. Nothing sends until you resume or send a prompt yourself.';
    case 'background':
      return `⏳ Waiting for ${runningBackground} background shell${runningBackground === 1 ? '' : 's'} to finish before sending the next prompt.`;
    case 'subagents':
      return `⏳ Waiting for ${runningSubagents} subagent${runningSubagents === 1 ? '' : 's'} to finish before sending the next prompt.`;
  }
}

export default function QueueHoldBanner({ hold, sessionId, card, runningSubagents = 0, runningBackground = 0 }: Props) {
  const canRelease = useIsReleaseWindow();

  /** The queue's Resume after a user cancel — the server clears the hold. */
  const handleResumeAfterCancel = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue/resume`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // resumed: false means nothing was held any more — another device got
      // there first, or your own prompt already cleared it.
      const body = (await res.json().catch(() => ({}))) as { resumed?: boolean };
      showToast(body.resumed === false ? 'The queue is already running' : 'Queue resumed', 'info', 1500);
    } catch {
      showToast('Could not resume the queue — try again', 'error', 2500);
    }
  }, [sessionId]);

  return (
    <div className={`${styles.queueAutoSendBanner} ${styles.queueHoldBanner}`} role="status">
      <span>
        {holdText(hold, runningSubagents, runningBackground)}
        {hold === 'not-started' && !canRelease && ' Release it in the main AASC window.'}
      </span>
      {hold === 'cancelled' && (
        <button type="button" className={btnClass} onClick={() => { void handleResumeAfterCancel(); }}>
          Resume
        </button>
      )}
      {hold === 'not-started' && canRelease && card && (
        <button
          type="button"
          className={btnClass}
          title="Only in this window, and only for this session until it is restarted"
          onClick={() => useStartReleaseStore.getState().release(card)}
        >
          It is ready — send anyway
        </button>
      )}
    </div>
  );
}
