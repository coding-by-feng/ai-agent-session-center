/**
 * PhoneConfirmCard — a central's confirmation, answerable from the phone's Inbox (AASC P5-15).
 *
 *   ⚠ A central asks                       expires in 4:52
 *   Stop the session "api" (it is pinned: a kill unpins it)
 *   Target: agent-manager-2 · 1a2b3c4d
 *   Written by the central
 *   ┌ the central's own words, as text ┐
 *   [ Deny ] [ Allow once ]
 *
 * A central steers other sessions through AASC's /mcp tools, and anything that is the person's to decide waits
 * as a card (server/mcp/confirm.ts). The server sends the phone only the cards it could already act on itself,
 * about sessions shared with it (`mcp_phone_confirm`, feed: `phoneConfirmStore`). An unanswered card expires on
 * its own and counts as denied, so it is hidden the second it is past its time.
 *
 * Four things keep a stray tap from answering for the person, as on the desktop stack (ConfirmStack):
 *   - nothing takes focus when a card appears;
 *   - the central's text is only ever rendered as text (React escapes it; no `dangerouslySetInnerHTML`);
 *   - **Allow once** is disabled for the first 600 ms a card shows (P3-28), Deny stays live;
 *   - cards are oldest first, so a newer card lands below an older one and never moves its buttons. The button row
 *     reserves the line the disabled reason takes, so Allow unlocking changes nothing under the thumb.
 */
import { useEffect, useState } from 'react';
import { Button } from '../kit';
import { WarningIcon } from './chatIcons';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { McpConfirmView } from '@/types/mcpConfirm';
import styles from '@/styles/modules/mobile/PhoneConfirmCard.module.css';

/** How long Allow stays disabled after a card first shows. */
const ALLOW_DELAY_MS = 600;
const TICK_MS = 1_000;
/** How much of a session id is shown. */
const SHORT_ID_LENGTH = 8;

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

export interface PhoneConfirmCardProps {
  confirm: McpConfirmView;
  now: number;
}

export default function PhoneConfirmCard({ confirm, now }: PhoneConfirmCardProps) {
  const answer = usePhoneConfirmStore((s) => s.answer);
  const target = useSessionStore((s) => (confirm.targetSessionId ? s.sessions.get(confirm.targetSessionId) : undefined));
  const [deciding, setDeciding] = useState<'allow' | 'deny' | null>(null);
  const [failed, setFailed] = useState(false);
  // Armed once the card has been up for ALLOW_DELAY_MS; each card mounts when it first shows, so each gets its own.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ALLOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (deciding !== null) return;
    setDeciding(decision);
    setFailed(false);
    const outcome = await answer(confirm.cardId, decision);
    // The card leaves the list when the answer was taken (or there was nothing left to answer); only a failure stays.
    if (outcome === 'failed') {
      setFailed(true);
      setDeciding(null);
    }
  };

  const allowReason = deciding === 'deny' ? 'Sending your answer…' : !armed ? 'Allow unlocks in a moment' : undefined;
  const denyReason = deciding === 'allow' ? 'Sending your answer…' : undefined;

  return (
    <article
      className={styles.card}
      data-risk={confirm.risk}
      data-testid="phone-confirm-card"
      aria-label={`A central asks: ${confirm.summary}`}
      aria-busy={deciding !== null}
    >
      <div className={styles.eyebrow}>
        <span className={styles.icon}><WarningIcon /></span>
        <span className={styles.who}>A central asks</span>
        <span className={styles.expires}>{`expires in ${countdown(confirm.expiresAt - now)}`}</span>
      </div>
      <p className={styles.summary}>{confirm.summary}</p>
      {confirm.targetSessionId && (
        <p className={styles.target}>
          {target ? `Target: ${sessionDisplayTitle(target)} · ` : 'Target: '}
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
      {failed && <p className={styles.error} role="alert">The answer could not be delivered. Try again.</p>}
      <div className={styles.actions}>
        <Button
          small
          className={styles.deny}
          disabledReason={denyReason}
          loading={deciding === 'deny'}
          onClick={() => void decide('deny')}
        >
          Deny
        </Button>
        <Button
          small
          variant="primary"
          disabledReason={allowReason}
          loading={deciding === 'allow'}
          onClick={() => void decide('allow')}
        >
          Allow once
        </Button>
      </div>
    </article>
  );
}

export interface PhoneConfirmListProps {
  confirms: readonly McpConfirmView[];
  /** Called with the time when a card has run out, so its holder can drop it. */
  onExpired?: (now: number) => void;
}

/**
 * The waiting cards, oldest first, each hidden the moment it is past its time. The store holds each `expiresAt` on
 * this phone's clock (phoneConfirmStore), so the countdown is right however far the phone's clock is from the Mac's.
 */
export function PhoneConfirmList({ confirms, onExpired }: PhoneConfirmListProps) {
  const now = useNow(confirms.length > 0);

  useEffect(() => {
    if (confirms.some((c) => c.expiresAt <= now)) onExpired?.(now);
  }, [confirms, now, onExpired]);

  const live = confirms.filter((c) => c.expiresAt > now);
  if (live.length === 0) return null;
  return (
    <section className={styles.list} aria-label="Central confirmations">
      <div className={styles.live} role="status" aria-live="polite" aria-atomic="true">
        {`${live.length} ${live.length === 1 ? 'confirmation' : 'confirmations'} waiting`}
      </div>
      {live.map((c) => (
        <PhoneConfirmCard key={c.cardId} confirm={c} now={now} />
      ))}
    </section>
  );
}
