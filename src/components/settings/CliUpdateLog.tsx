/**
 * CliUpdateLog — under an agent CLI's row in Settings ▸ ADVANCED ▸ Agent CLIs (Oct 26 2026). While
 * its update runs: how long it has run against the 5-minute limit (neither updater reports a
 * percentage) and the updater's output as it arrives (`update.log`, streamed by the server). After:
 * the same output behind "Show log", open by itself when the update failed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { formatElapsed, logToggleLabel } from '@/lib/cliVersionsView';
import { CLI_UPDATE_TIMEOUT_MS, type CliVersionInfo } from '@/types/cliVersions';
import styles from '@/styles/modules/Settings.module.css';

const TICK_MS = 1000;
/** Within this many px of the bottom, the log follows new lines; scrolled further up, it stays put. */
const STICK_PX = 8;
const LIMIT = formatElapsed(CLI_UPDATE_TIMEOUT_MS);

/** The current time, ticking each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function LogBox({ id, lines, running, label }: { id: string; lines: string[]; running: boolean; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0) {
    return (
      <p id={id} className={styles.cliLogEmpty}>
        {running ? 'No output yet. The updater may print only when it finishes.' : 'The updater printed nothing.'}
      </p>
    );
  }
  return (
    <pre
      id={id}
      ref={ref}
      className={styles.cliLog}
      role="log"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}
    >
      {lines.join('\n')}
    </pre>
  );
}

export default function CliUpdateLog({ info, name }: { info: CliVersionInfo; name: string }) {
  const { update } = info;
  const running = update.state === 'updating';
  const now = useNow(running);
  const [open, setOpen] = useState<boolean | null>(null);
  const logId = useId();

  // Nothing ran since the server started: no log to show.
  if (!running && update.startedAt === undefined) return null;
  const lines = update.log ?? [];
  const label = `${name} update output`;

  if (running) {
    const elapsed = update.startedAt === undefined ? 0 : Math.max(0, now - update.startedAt);
    const text = `${formatElapsed(elapsed)} elapsed · stops at ${LIMIT}`;
    return (
      <div className={styles.cliLogArea}>
        <div className={styles.cliProgressRow}>
          <progress
            className={styles.cliProgress}
            max={CLI_UPDATE_TIMEOUT_MS}
            value={Math.min(elapsed, CLI_UPDATE_TIMEOUT_MS)}
            aria-label={`${name} update time`}
            aria-valuetext={text}
          />
          <span className={styles.cliElapsed}>{text}</span>
        </div>
        <LogBox id={logId} lines={lines} running label={label} />
      </div>
    );
  }

  const shown = open ?? update.state === 'failed';
  const took = update.at !== undefined && update.startedAt !== undefined ? update.at - update.startedAt : null;
  return (
    <div className={styles.cliLogArea}>
      <button
        type="button"
        className={styles.cliLogToggle}
        aria-expanded={shown}
        aria-controls={shown ? logId : undefined}
        onClick={() => setOpen(!shown)}
      >
        <span aria-hidden="true">{shown ? '▾' : '▸'}</span> {logToggleLabel(lines.length, took, shown)}
      </button>
      {shown && <LogBox id={logId} lines={lines} running={false} label={label} />}
    </div>
  );
}
