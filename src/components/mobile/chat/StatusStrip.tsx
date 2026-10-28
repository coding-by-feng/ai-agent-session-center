/**
 * StatusStrip — while the agent works (AASC-41): "● Working · Bash · 0:42  ■ Stop",
 * or compacts its context: "● Compacting context · auto · 0:23  ■ Stop" (timed from
 * PreCompact; Esc cancels a compaction too). The terminal's last lines sit under it
 * only once ⌄ asks for them (Oct 19 2026, remembered per phone: peekPreference).
 * and the terminal peek under it, whose opened face has "Open terminal" (AASC-56). Status and tool come from the session object
 * (hook-driven, instant), not from the transcript.
 *
 * Stop is Esc, written to the session's terminal the way the phone's key bar
 * writes keys (`writeTerminal`, POST /api/terminals/:id/write). It is the phone's
 * only Stop (Oct 20 2026: the composer had a second, which asked first where this
 * one didn't): while a tool runs it asks first, since stopping interrupts the tool.
 *
 * Oct 28 2026: once Esc is written the button holds "Stopping…" (busy) and the strip
 * reads "Stopping", until the turn ends or a new one starts, or STOP_PENDING_MS
 * passes with the agent still working (then Stop can be pressed again). Before, it
 * was busy only for the write itself, so a tap looked like it did nothing.
 */
import { useEffect, useId, useState } from 'react';
import type { Session } from '@/types';
import { useControlBaton } from '@/hooks/useControlBaton';
import { PHONE_KEY_SEQUENCES, writeTerminal } from '@/lib/terminalCompose';
import { formatDuration } from '@/lib/chat/chatFormat';
import { isCompacting } from '@/lib/chat/phoneStatus';
import { runningTool } from '@/lib/chat/composerAction';
import { detectCli } from '@/lib/cliDetect';
import { readPeekOpen, writePeekOpen } from '@/lib/chat/peekPreference';
import { Button, ConfirmSheet } from '../kit';
import TerminalPeek from './TerminalPeek';
import { ChevronIcon, SquareStopIcon } from './chatViewIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

const TICK_MS = 1000;
/** How long a written Stop holds "Stopping…" before Stop is offered again. */
export const STOP_PENDING_MS = 10_000;

/** When the current turn began: the last prompt, else the last activity. */
function turnStart(session: Session): number {
  const prompts = session.promptHistory;
  const last = prompts && prompts.length > 0 ? prompts[prompts.length - 1].timestamp : 0;
  return last || session.lastActivityAt || Date.now();
}

/** The tool in use now, if the newest call belongs to this turn. */
function currentTool(session: Session, since: number): string | null {
  const log = session.toolLog;
  const last = log && log.length > 0 ? log[log.length - 1] : null;
  return last && last.timestamp >= since ? last.tool : null;
}

export interface StatusStripProps {
  session: Session;
  peek: readonly string[];
  /** Opens the session's terminal screen, from the opened peek (AASC-56). */
  onOpenTerminal: () => void;
}

export default function StatusStrip({ session, peek, onOpenTerminal }: StatusStripProps) {
  const { sessionId, terminalId } = session;
  const baton = useControlBaton(sessionId);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  /** When Esc was written, and for which turn (its start). */
  const [stopSent, setStopSent] = useState<{ at: number; turn: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The tool a confirmed Stop would interrupt, while its confirm is open. */
  const [confirmTool, setConfirmTool] = useState<string | null>(null);
  const cli = detectCli(session);
  const cliName = cli === 'codex' ? 'Codex' : cli === 'claude' ? 'Claude' : 'the agent';
  const [peekOpen, setPeekOpen] = useState(readPeekOpen);
  const peekId = useId();
  const togglePeek = () => {
    const next = !peekOpen;
    setPeekOpen(next);
    writePeekOpen(next);
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const compacting = isCompacting(session, now) ? session.compacting : null;
  const since = compacting ? compacting.since : turnStart(session);
  const tool = compacting ? null : currentTool(session, since);
  const elapsed = formatDuration(Math.max(0, now - since));
  // Worked out on each tick, never set by an effect: a new turn or the timeout ends it.
  const stopPending = !!stopSent && stopSent.turn === since && now - stopSent.at < STOP_PENDING_MS;
  const label = stopPending
    ? 'Stopping'
    : compacting
      ? ['Compacting context', compacting.trigger].filter(Boolean).join(' · ')
      : session.status === 'prompting' ? 'Starting' : 'Working';

  const stop = async () => {
    if (!terminalId) return;
    const turn = since;
    setStopping(true);
    setError(null);
    const result = await writeTerminal(terminalId, PHONE_KEY_SEQUENCES.esc);
    setStopping(false);
    if (result.ok) {
      const at = Date.now();
      setStopSent({ at, turn });
      setNow(at);
    } else {
      setError(result.message);
    }
  };
  const askStop = () => {
    const running = runningTool(session);
    if (running) setConfirmTool(running);
    else void stop();
  };

  const disabledReason = !terminalId
    ? 'No terminal to stop'
    : baton.mode === 'spectator'
      ? `${baton.holder?.label ?? 'Another device'} is driving`
      : undefined;

  return (
    <div className={styles.strip} data-testid="chat-status-strip">
      <div className={styles.stripRow}>
        <span className={styles.stripDot} aria-hidden="true" />
        {/* The time has its own box, so a long label truncates before the time does. */}
        <span className={styles.stripLabel}>
          <span className={styles.stripText}>
            {label}
            {tool && <> · <span className={styles.stripTool}>{tool}</span></>}
          </span>
          {elapsed && <span className={styles.stripTime}> · <span aria-label={`for ${elapsed}`}>{elapsed}</span></span>}
        </span>
        <button
          type="button"
          className={styles.stripToggle}
          data-open={peekOpen ? '' : undefined}
          aria-expanded={peekOpen}
          aria-controls={peekOpen ? peekId : undefined}
          aria-label="Show the terminal’s last lines"
          onClick={togglePeek}
        >
          <ChevronIcon size={18} />
        </button>
        <Button
          small
          variant="secondary"
          icon={<SquareStopIcon size={16} />}
          onClick={askStop}
          loading={stopping || stopPending}
          loadingLabel="Stopping…"
          disabledReason={disabledReason}
          aria-label="Stop the agent (Esc)"
          className={styles.stripStop}
        >
          {stopping || stopPending ? 'Stopping…' : 'Stop'}
        </Button>
      </div>
      {error && <p className={styles.stripError} role="alert">{error}</p>}
      {peekOpen && (
        <div id={peekId}>
          <TerminalPeek terminalId={terminalId} lines={peek} onOpenTerminal={onOpenTerminal} />
        </div>
      )}
      <ConfirmSheet
        open={confirmTool !== null}
        title={`Stop ${cliName}?`}
        message={`It is running ${confirmTool ?? 'a tool'}. Stopping interrupts it.`}
        confirmLabel="Stop"
        danger
        onConfirm={() => { setConfirmTool(null); void stop(); }}
        onCancel={() => setConfirmTool(null)}
      />
    </div>
  );
}
