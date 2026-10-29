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
 * A central session (server/mcp) also gets one ★ line saying what it can reach and how many
 * workers it runs: the card's star is the star alone (Oct 26 2026), so its scope lives here.
 */
import { useState } from 'react';
import type { Session } from '@/types';
import { PEEK_PROMPT_COUNT, promptAge, typedPrompts } from '@/lib/promptPeek';
import { quietFor } from '@/lib/liveBoard';
import { statusLabel } from '@/lib/sessionStatusStyle';
import { centralTooltip, workersText } from '@/lib/centralChoice';
import { useMcpStore } from '@/stores/mcpStore';
import { useCentralSessionsShown } from '@/stores/centralFeatureStore';
import { useRoomStore } from '@/stores/roomStore';
import styles from '@/styles/modules/SessionPromptPeek.module.css';

export default function SessionPromptPeek({ session }: { session: Session }) {
  // The tooltip mounts this when it opens: one clock reading for the few seconds it is read.
  const [now] = useState(() => Date.now());
  const prompts = typedPrompts(session, PEEK_PROMPT_COUNT, 'full');
  const quiet = quietFor(session, now);
  const meta = [session.projectName, statusLabel(session.status), quiet && `quiet ${quiet}`].filter(Boolean).join(' · ');
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  // No ★ line while central sessions are off (centralFeatureStore); the marker stays.
  const central = useCentralSessionsShown() ? session.central : undefined;
  const roomName = useRoomStore((s) =>
    central?.kind === 'room' ? s.rooms.find((r) => r.id === central.scopeRef)?.name : undefined,
  );
  const workers = workersText(useMcpStore((s) => (central ? s.centrals.get(central.centralId)?.workerCount ?? 0 : 0)));
  return (
    <div className={styles.peek}>
      {meta && <p className={styles.meta}>{meta}</p>}
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
