/**
 * RecentPromptsSheet — a hold on a session's title in the phone app (Oct 23 2026):
 * where the session runs, the user's remark and the last prompts the user typed
 * into it, newest first, so a session can be recognised and its recent asks
 * reviewed without leaving the tab. A tap on a prompt opens it in the Prompts tab
 * (full text, Copy, Use again); "All prompts" opens that tab. The desktop shows the
 * same list when the pointer rests on a session (`SessionPromptPeek`); the rule for
 * "typed" is `lib/promptPeek.ts`. A tap on the title still opens Info.
 */
import { useState } from 'react';
import { ListRow, ListSection, Sheet } from '../kit';
import { useSessionStore } from '@/stores/sessionStore';
import { promptAge, typedPrompts, type PeekPrompt } from '@/lib/promptPeek';
import { quietFor } from '@/lib/liveBoard';
import { statusLabel } from '@/lib/sessionStatusStyle';
import styles from '@/styles/modules/mobile/RecentPrompts.module.css';

const FIT = ['fit'] as const;

export interface RecentPromptsSheetProps {
  sessionId: string;
  /** Keep it stable: the sheet's focus handling re-runs when it changes. */
  onClose: () => void;
  /** A prompt was tapped: show it in the Prompts tab. */
  onOpenPrompt: (prompt: PeekPrompt) => void;
  /** "All prompts": the Prompts tab. */
  onAllPrompts: () => void;
}

export default function RecentPromptsSheet({ sessionId, onClose, onOpenPrompt, onAllPrompts }: RecentPromptsSheetProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  // Read once as the sheet opens: the ages are for the few seconds it is read.
  const [now] = useState(() => Date.now());
  if (!session) return null;
  const prompts = typedPrompts(session);
  const quiet = quietFor(session, now);
  const meta = [session.projectName, statusLabel(session.status), quiet && `quiet ${quiet}`].filter(Boolean).join(' · ');
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  return (
    <Sheet open heldOpen onClose={onClose} title="Recent prompts" detents={FIT} testId="recent-prompts-sheet">
      {meta && <p className={styles.meta}>{meta}</p>}
      {remark && <p className={styles.remark}>{remark}</p>}
      {prompts.length === 0 && <p className={styles.empty}>No prompts typed yet.</p>}
      <ListSection label="Recent prompts">
        {prompts.map((p, i) => (
          <ListRow
            key={`${p.at}:${i}`}
            title={<span className={styles.text}>{p.text}</span>}
            trailing={<span className={styles.age}>{promptAge(p.at, now)}</span>}
            chevron
            tall
            onClick={() => onOpenPrompt(p)}
          />
        ))}
        <ListRow title="All prompts" chevron onClick={onAllPrompts} />
      </ListSection>
    </Sheet>
  );
}
