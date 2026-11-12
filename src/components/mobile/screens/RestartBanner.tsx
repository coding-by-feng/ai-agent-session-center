/**
 * RestartBanner — the phone's Restart, step by step, on the session's screen (Nov 8 2026):
 * "Restarting · Stopping the agent…" (1 of 3) → "Starting Claude in a new terminal…"
 * (2 of 3) → "Restarted" (closes itself) or "Didn’t restart" with the reason (kept until
 * Dismiss). No session name: the screen's header already says it, and a long one doubled
 * the banner's height. The steps come from restartProgressStore; while this banner is
 * mounted, the end it shows is not also toasted.
 */
import { useEffect } from 'react';
import { Banner } from '../kit';
import { useRestartProgressStore } from '@/stores/restartProgressStore';
import type { RestartTrack } from '@/lib/chat/restartProgress';
import styles from '@/styles/modules/mobile/Screens.module.css';

const STEP_OF: Record<RestartTrack['phase'], number> = { stopping: 1, starting: 2, done: 3, failed: 3 };

function Steps({ step }: { step: number }) {
  return (
    <span className={styles.restartSteps}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={styles.restartDot} data-state={n < step ? 'done' : n === step ? 'now' : 'next'} aria-hidden="true" />
      ))}
      <span className={styles.srOnly}>Step {step} of 3</span>
    </span>
  );
}

export default function RestartBanner({ sessionId }: { sessionId: string }) {
  const track = useRestartProgressStore((s) => s.tracks.get(sessionId));
  const watch = useRestartProgressStore((s) => s.watch);
  const dismiss = useRestartProgressStore((s) => s.dismiss);
  useEffect(() => watch(sessionId), [watch, sessionId]);
  if (!track) return null;

  if (track.phase === 'failed') {
    return (
      <Banner tone="error" title="Didn’t restart" action={{ label: 'Dismiss', onClick: () => dismiss(sessionId) }}>
        {track.error}
      </Banner>
    );
  }
  if (track.phase === 'done') {
    return (
      <Banner tone="success" title="Restarted">
        {track.error ?? 'Same conversation, new terminal.'}
      </Banner>
    );
  }
  return (
    <Banner tone="info" title="Restarting">
      <span className={styles.restartLine}>
        <span>{track.phase === 'stopping' ? 'Stopping the agent…' : `Starting ${track.cli} in a new terminal…`}</span>
        <Steps step={STEP_OF[track.phase]} />
      </span>
    </Banner>
  );
}
