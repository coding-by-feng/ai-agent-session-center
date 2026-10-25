/**
 * SessionPromptPeek — what hovering a session shows (Oct 23 2026): where it runs
 * and what state it is in, the user's own remark, and the last prompts the user
 * typed into it, newest first with how long ago. The body of a `Tooltip` (whose
 * label is the session's name) on the strip's cards and the panel header's title,
 * so sessions can be told apart and reviewed without opening them. The phone's
 * long press on the session title shows the same list in a sheet
 * (`RecentPromptsSheet`); the rule for "typed" is `lib/promptPeek.ts`.
 */
import { useState } from 'react';
import type { Session } from '@/types';
import { promptAge, typedPrompts } from '@/lib/promptPeek';
import { quietFor } from '@/lib/liveBoard';
import { statusLabel } from '@/lib/sessionStatusStyle';
import styles from '@/styles/modules/SessionPromptPeek.module.css';

export default function SessionPromptPeek({ session }: { session: Session }) {
  // The tooltip mounts this when it opens: one clock reading for the few seconds it is read.
  const [now] = useState(() => Date.now());
  const prompts = typedPrompts(session);
  const quiet = quietFor(session, now);
  const meta = [session.projectName, statusLabel(session.status), quiet && `quiet ${quiet}`].filter(Boolean).join(' · ');
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  return (
    <div className={styles.peek}>
      {meta && <p className={styles.meta}>{meta}</p>}
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
