/**
 * SessionPromptPeek — what hovering a session shows (Oct 23 2026): where it runs
 * and what state it is in, the user's own remark, and the last prompts the user
 * typed into it, newest first with how long ago. The body of a `Tooltip` (whose
 * label is the session's name) on the strip's cards and the panel header's title,
 * so sessions can be told apart and reviewed without opening them. The phone's
 * long press on the session title shows the same list in a sheet
 * (`RecentPromptsSheet`); the rule for "typed" is `lib/promptPeek.ts`.
 *
 * Each prompt is shown whole, line breaks kept (Oct 29 2026, "show the prompt fully"):
 * the tooltip is `interactive`, so when the peek is taller than the window its body
 * scrolls and the pointer can move into it. The phone sheet keeps one line each.
 *
 * Summary (Nov 18 2026): a button beside the status line asks the Mac for a few lines on what
 * the session has done (`POST /api/sessions/:id/recap`, made from its newest prompts and last
 * replies only). The run and its answer live on the session (`Session.recap`), not in this
 * component, so they survive the peek closing and show on every device. Never asked on hover:
 * each run spends tokens. Once made it is shown on every hover; "Update" appears when a newer
 * prompt was typed. Full desktop only (`IS_LITE` hides the button).
 *
 * A central session (server/mcp) also gets one ★ line saying what it can reach and how many
 * workers it runs: the card's star is the star alone (Oct 26 2026), so its scope lives here.
 */
import { useState, type MouseEvent } from 'react';
import type { Session } from '@/types';
import { PEEK_PROMPT_COUNT, promptAge, typedPrompts } from '@/lib/promptPeek';
import { quietFor } from '@/lib/liveBoard';
import { statusLabel, statusOrCompacting } from '@/lib/sessionStatusStyle';
import { centralTooltip, workersText } from '@/lib/centralChoice';
import { useMcpStore } from '@/stores/mcpStore';
import { useCentralSessionsShown } from '@/stores/centralFeatureStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { recapIsStale } from '@/lib/sessionRecap';
import { IS_LITE } from '@/lib/edition';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/SessionPromptPeek.module.css';

export default function SessionPromptPeek({ session }: { session: Session }) {
  // The tooltip mounts this when it opens: one clock reading for the few seconds it is read.
  const [now] = useState(() => Date.now());
  const prompts = typedPrompts(session, PEEK_PROMPT_COUNT, 'full');
  const quiet = quietFor(session, now);
  const meta = [session.projectName, statusLabel(statusOrCompacting(session)), quiet && `quiet ${quiet}`].filter(Boolean).join(' · ');
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  // No ★ line while central sessions are off (centralFeatureStore); the marker stays.
  const central = useCentralSessionsShown() ? session.central : undefined;
  const roomName = useRoomStore((s) =>
    central?.kind === 'room' ? s.rooms.find((r) => r.id === central.scopeRef)?.name : undefined,
  );
  const workers = workersText(useMcpStore((s) => (central ? s.centrals.get(central.centralId)?.workerCount ?? 0 : 0)));
  // The live session, not the prop: the card's tooltip is drawn from a memoised strip, and the
  // answer arrives as a session update while the peek is open.
  const live = useSessionStore((s) => s.sessions.get(session.sessionId)) ?? session;
  const recap = live.recap;
  const [asking, setAsking] = useState(false);
  const running = asking || recap?.state === 'running';
  const stale = !!recap && recap.state !== 'running' && recapIsStale(live, recap);
  const ask = (event: MouseEvent) => {
    event.stopPropagation();
    setAsking(true);
    fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/recap`, { method: 'POST' })
      .then(async (res) => {
        if (res.ok) return;
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        showToast(typeof body?.error === 'string' ? body.error : 'Couldn’t summarize this session.', 'error');
      })
      .catch(() => showToast('Couldn’t reach the Mac to summarize this session.', 'error'))
      .finally(() => setAsking(false));
  };
  // One button, named for what a click does now; none while the summary is current.
  const action = running ? { label: 'Summarizing…', name: 'Summarizing this session' }
    : !recap ? { label: 'Summary', name: 'Summarize what this session has done' }
    : recap.state === 'error' ? { label: 'Try again', name: 'Try the summary again' }
    : stale ? { label: 'Update', name: 'Update the summary' }
    : null;
  const showAction = !IS_LITE && prompts.length > 0 && action !== null;
  const recapAge = recap ? promptAge(recap.at, now) : '';
  return (
    <div className={styles.peek}>
      {(meta || showAction) && (
        <div className={styles.head}>
          <p className={styles.meta}>{meta}</p>
          {showAction && (
            <button type="button" className={styles.recapButton} onClick={ask} disabled={running} aria-label={action.name}>
              <SparkIcon />
              {action.label}
            </button>
          )}
        </div>
      )}
      {recap && (recap.text || recap.state === 'error') && (
        <section className={styles.recap} aria-label="Summary">
          {recap.text && (
            <>
              <p className={styles.recapHead}>
                <SparkIcon />
                {`Summary${recap.state === 'done' && recapAge ? ` · ${recapAge === '<1m' ? 'just now' : `${recapAge} ago`}` : ''}${stale ? ' · from before your last prompt' : ''}`}
              </p>
              <p className={styles.recapText}>{recap.text}</p>
            </>
          )}
          {recap.state === 'error' && <p className={styles.recapError}>{`Couldn’t summarize: ${recap.error ?? 'the summarizer failed'}.`}</p>}
        </section>
      )}
      {central && (
        <p className={styles.central}>{`★ ${centralTooltip(central, roomName)}${workers ? ` · ${workers}` : ''}`}</p>
      )}
      {remark && <p className={styles.remark}>{remark}</p>}
      {prompts.length > 0 ? (
        <ol className={styles.list} aria-label="Recent prompts">
          {prompts.map((p, i) => (
            <li key={`${p.at}:${i}`} className={styles.item}>
              <span className={styles.age}>{promptAge(p.at, now)}</span>
              <span className={styles.text}>{p.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.empty}>No prompts typed yet.</p>
      )}
    </div>
  );
}

/** A four-point spark: the mark of something AI wrote. Decorative; the button and the block carry the words. */
function SparkIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" aria-hidden="true" className={styles.spark}>
      <path d="M6 0.5 7.3 4.7 11.5 6 7.3 7.3 6 11.5 4.7 7.3 0.5 6 4.7 4.7Z" />
    </svg>
  );
}

