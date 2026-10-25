/**
 * ConfirmStack — the cards a central's confirmations wait on (server/mcp/confirm.ts, P3).
 *
 * A central asks the person before it does anything that is theirs to decide; the tool waits, and the question
 * lands here as a card in the bottom-right corner of the dashboard window (the feed is `mcpConfirmStore`).
 * Each card names who asks (the central's scope: global, room "<name>", project "<folder>"), says what in AASC's
 * own words, names the card the call is about, and shows whatever the central itself wrote, verbatim, as text.
 * **Allow once** and **Deny** answer it; an unanswered card expires on its own and counts as denied.
 *
 * Four things keep a stray action from answering for the person: nothing takes focus when a card appears,
 * Escape does nothing here, the central's text is only ever rendered as text (React escapes it; there is no
 * `dangerouslySetInnerHTML`), and **Allow once** is disabled for the first 600 ms a card shows (Deny stays live), so
 * a click aimed at something else cannot land on it as a card arrives. For the same reason the stack is a reversed
 * column: the oldest card is first in the DOM and sits in the corner, a newer card grows upward above it, and no
 * card's buttons move when another arrives. At most three cards show at once, oldest first, then "+N more waiting"
 * (above the newest).
 *
 * The stack is portaled to `document.body` at `--z-confirm`, above the detail panel, the modals, the fullscreen
 * terminal and the portaled menus: a card that a panel hides would expire unseen and count as denied.
 * It is mounted once in App, beside the toasts.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Button from '@/components/ui/Button';
import { scopeName } from '@/lib/centralChoice';
import { useMcpConfirmStore } from '@/stores/mcpConfirmStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { McpConfirmView } from '@/types/mcpConfirm';
import styles from '@/styles/modules/ConfirmStack.module.css';

/** The most cards shown at once. */
const MAX_VISIBLE = 3;
/** How much of a session id is shown. */
const SHORT_ID_LENGTH = 8;
const TICK_MS = 1_000;
/** How long Allow stays disabled after a card first shows. */
const ALLOW_DELAY_MS = 600;

/** `2:05` for 125 seconds. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** The time now, refreshed every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const refresh = () => setNow(Date.now());
    // The clock may be hours old when the first card arrives: catch up at once, then every second.
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

interface ConfirmCardProps {
  confirm: McpConfirmView;
  now: number;
}

function ConfirmCard({ confirm, now }: ConfirmCardProps) {
  const answer = useMcpConfirmStore((s) => s.answer);
  const central = useMcpStore((s) => s.centrals.get(confirm.centralId));
  // A string or undefined, so the card re-renders when its room is renamed and not when any other changes.
  const roomName = useRoomStore((s) =>
    central?.kind === 'room' ? s.rooms.find((r) => r.id === central.scopeRef)?.name : undefined,
  );
  const targetTitle = useSessionStore((s) =>
    confirm.targetSessionId ? s.sessions.get(confirm.targetSessionId)?.title : undefined,
  );
  const [deciding, setDeciding] = useState<'allow' | 'deny' | null>(null);
  const [failed, setFailed] = useState(false);
  // Armed once the card has been up for ALLOW_DELAY_MS; the card mounts when it first shows (one past the visible
  // limit mounts later, when it takes a place), so each card gets its own delay.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ALLOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const who = central ? `★ ${scopeName(central, roomName)}` : 'A central';

  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    setDeciding(decision);
    setFailed(false);
    const outcome = await answer(confirm.cardId, decision);
    // The card leaves the list when the answer was taken (or there was nothing left to answer); only a failure stays.
    if (outcome === 'failed') {
      setFailed(true);
      setDeciding(null);
    }
  };

  return (
    <article className={styles.card} aria-label={`${who} asks: ${confirm.summary}`} aria-busy={deciding !== null}>
      <div className={styles.eyebrow}>
        <span className={styles.who}>{`${who} wants to`}</span>
        <span className={styles.expires}>{`expires in ${countdown(confirm.expiresAt - now)}`}</span>
      </div>
      <p className={styles.summary}>{confirm.summary}</p>
      {confirm.targetSessionId && (
        <p className={styles.target}>
          {targetTitle ? `Target: ${targetTitle} · ` : 'Target: '}
          <span className={styles.targetId}>{confirm.targetSessionId.slice(0, SHORT_ID_LENGTH)}</span>
        </p>
      )}
      {confirm.detail !== null && confirm.detail !== '' && (
        <div className={styles.detailBlock}>
          <span className={styles.detailLabel}>Written by the central</span>
          {/* The central's own words: plain text in a scrolling box, which a keyboard can reach and scroll. */}
          <pre className={styles.detail} tabIndex={0} aria-label="Text written by the central">
            {confirm.detail}
          </pre>
        </div>
      )}
      {failed && <p className={styles.error}>The answer could not be delivered. Try again.</p>}
      <div className={styles.actions}>
        <Button
          variant="primary"
          className={styles.action}
          disabled={deciding !== null || !armed}
          onClick={() => void decide('allow')}
        >
          Allow once
        </Button>
        <Button className={styles.action} disabled={deciding !== null} onClick={() => void decide('deny')}>
          Deny
        </Button>
      </div>
    </article>
  );
}

export default function ConfirmStack() {
  const confirms = useMcpConfirmStore((s) => s.confirms);
  const prune = useMcpConfirmStore((s) => s.prune);
  const now = useNow(confirms.length > 0);

  // A card past its time is hidden at once (below) and dropped from the store here.
  useEffect(() => {
    if (confirms.some((c) => c.expiresAt <= now)) prune(now);
  }, [confirms, now, prune]);

  const live = confirms.filter((c) => c.expiresAt > now);
  const shown = live.slice(0, MAX_VISIBLE);
  const hidden = live.length - shown.length;

  return createPortal(
    <>
      <div className={styles.live} aria-live="polite" aria-atomic="true">
        {live.length > 0 ? `${live.length} ${live.length === 1 ? 'confirmation' : 'confirmations'} waiting` : ''}
      </div>
      {live.length > 0 && (
        <section className={styles.stack} aria-label="Central confirmations">
          {shown.map((c) => (
            <ConfirmCard key={c.cardId} confirm={c} now={now} />
          ))}
          {hidden > 0 && <span className={styles.more}>{`+${hidden} more waiting`}</span>}
        </section>
      )}
    </>,
    document.body,
  );
}
