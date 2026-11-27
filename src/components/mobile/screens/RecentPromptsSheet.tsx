/**
 * RecentPromptsSheet — a hold on a session's title in the phone app (Oct 23 2026):
 * where the session runs, the user's remark and the last prompts the user typed
 * into it, newest first, so a session can be recognised and its recent asks
 * reviewed without leaving the tab. A tap on a prompt opens it in the Prompts tab
 * (full text, Copy, Use again); "All prompts" opens that tab. The desktop shows the
 * same list when the pointer rests on a session (`SessionPromptPeek`); the rule for
 * "typed" is `lib/promptPeek.ts`. A tap on the title still opens Info.
 *
 * Summary (Nov 27 2026): the desktop peek's AI Summary — what the Mac last made for this session, how old
 * it is, whether a prompt came after it, why it failed — and one button named for what a press does
 * (`useSessionRecap`, the rule the desktop shares). Never asked on opening: each run spends tokens. The
 * Sessions list's long-press menu opens this sheet too ("Recent prompts…", "Summarize").
 */
import { useState } from 'react';
import { Button, ListRow, ListSection, Sheet } from '../kit';
import { useSessionStore } from '@/stores/sessionStore';
import { promptAge, typedPrompts, type PeekPrompt } from '@/lib/promptPeek';
import { quietFor } from '@/lib/liveBoard';
import { statusLabel, statusOrCompacting } from '@/lib/sessionStatusStyle';
import { useSessionRecap } from '@/hooks/useSessionRecap';
import { SparkIcon } from '../phoneIcons';
import type { Session } from '@/types';
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
  return <RecentPromptsBody session={session} now={now} onClose={onClose} onOpenPrompt={onOpenPrompt} onAllPrompts={onAllPrompts} />;
}

function RecentPromptsBody({ session, now, onClose, onOpenPrompt, onAllPrompts }: Omit<RecentPromptsSheetProps, 'sessionId'> & { session: Session; now: number }) {
  const { recap, running, stale, action, ask } = useSessionRecap(session);
  const prompts = typedPrompts(session);
  const quiet = quietFor(session, now);
  const meta = [session.projectName, statusLabel(statusOrCompacting(session)), quiet && `quiet ${quiet}`].filter(Boolean).join(' · ');
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  return (
    <Sheet open heldOpen onClose={onClose} title="Recent prompts" detents={FIT} testId="recent-prompts-sheet">
      {meta && <p className={styles.meta}>{meta}</p>}
      {recap && (recap.text || recap.state === 'error') && (
        <section className={styles.recap} aria-label="Summary">
          {recap.text && (
            <>
              <p className={styles.recapHead}>
                <SparkIcon width={14} height={14} />
                {`Summary${recap.state === 'done' ? ` · ${recapWhen(recap.at, now)}` : ''}${stale ? ' · from before your last prompt' : ''}`}
              </p>
              <p className={styles.recapText}>{recap.text}</p>
            </>
          )}
          {recap.state === 'error' && <p className={styles.recapError}>{`Couldn’t summarize: ${recap.error ?? 'the summarizer failed'}.`}</p>}
        </section>
      )}
      {prompts.length > 0 && (
        <div className={styles.recapAction}>
          <Button small icon={<SparkIcon width={18} height={18} />} loading={running} loadingLabel={action.name} aria-label={action.name} onClick={ask}>
            {action.label}
          </Button>
        </div>
      )}
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

/** "just now" or "3m ago": the peek's age, for a summary made on the Mac. */
function recapWhen(at: number, now: number): string {
  // A summary made after the sheet opened is newer than `now`: count it as just made.
  const age = promptAge(at, Math.max(now, at));
  return age === '<1m' ? 'just now' : `${age} ago`;
}
