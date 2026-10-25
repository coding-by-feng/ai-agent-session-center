/**
 * PromptTokens — a queued prompt's text with its skills and commands (`/raab`, and a
 * Codex session's `$skill`) drawn as tokens: bigger, bold, in the theme's accent
 * (Oct 21 2026). Used by every queue list, desktop and phone, so they agree.
 *
 * `splitPromptTokens` finds the words that look like one; only those that ARE one of
 * this CLI's commands or skills (the Mac's `/api/commands` for the row's session and
 * project, cached 30 s and shared by every row) are drawn as tokens, so a web route
 * in a prompt ("…the score of /checkout") stays text. Nothing is asked for a prompt
 * with no candidate, and the text stays plain until (or unless) the list loads.
 * Not a <mark>: that is the search highlight.
 *
 * `PromptSkillChips` draws the same tokens on their own line (Oct 22 2026): a queue row
 * shows it under a preview that is cut off, where a skill at the end ("… /raab") would
 * otherwise sit past the "…" and never be seen.
 */
import { useEffect, useMemo, useState } from 'react';
import { detectCli } from '@/lib/cliDetect';
import { entryToken, fetchCommandIndex } from '@/lib/commandIndex';
import { splitPromptTokens } from '@/lib/promptTokens';
import { useSessionStore } from '@/stores/sessionStore';
import styles from '@/styles/modules/PromptTokens.module.css';

export interface PromptTokensProps {
  text: string;
  /** The prompt's session: its CLI and project decide which words are commands or skills. */
  sessionId?: string;
}

const NONE: ReadonlySet<string> = new Set();

/** This CLI's command and skill tokens (`/name`, Codex skills `$name`), once `wanted`. */
function useKnownTokens(cli: 'claude' | 'codex', projectPath: string | null, wanted: boolean): ReadonlySet<string> {
  const key = `${cli}|${projectPath ?? ''}`;
  const [known, setKnown] = useState<{ key: string; tokens: ReadonlySet<string> }>({ key: '', tokens: NONE });
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void fetchCommandIndex(cli, projectPath).then((entries) => {
      if (live) setKnown({ key, tokens: new Set(entries.map(entryToken)) });
    });
    return () => {
      live = false;
    };
  }, [wanted, cli, projectPath, key]);
  return known.key === key ? known.tokens : NONE;
}

/** The prompt cut into runs, and which token runs are really this session's commands or skills. */
function usePromptTokens(text: string, sessionId: string | undefined) {
  const cli = useSessionStore((s) => {
    const session = sessionId ? s.sessions.get(sessionId) : undefined;
    return session ? detectCli(session) : null;
  });
  const projectPath = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId)?.projectPath ?? null : null));
  const runs = useMemo(() => splitPromptTokens(text, cli), [text, cli]);
  const known = useKnownTokens(cli ?? 'claude', projectPath, runs.some((r) => r.token));
  return { runs, known };
}

export default function PromptTokens({ text, sessionId }: PromptTokensProps) {
  const { runs, known } = usePromptTokens(text, sessionId);
  return (
    <>
      {runs.map((run, i) =>
        run.token && known.has(run.text) ? (
          <span key={i} className={styles.token} data-prompt-token="">{run.text}</span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}

/**
 * The prompt's commands and skills, each once and in the order they come, as tokens on a
 * line of their own; nothing when it has none. Display only (`aria-hidden`): the prompt's
 * own text, which a screen reader reads whole, already holds them.
 */
export function PromptSkillChips({ text, sessionId }: PromptTokensProps) {
  const { runs, known } = usePromptTokens(text, sessionId);
  const chips = [...new Set(runs.filter((r) => r.token && known.has(r.text)).map((r) => r.text))];
  if (chips.length === 0) return null;
  return (
    <span className={styles.chips} aria-hidden="true">
      {chips.map((chip) => (
        <span key={chip} className={styles.token} data-prompt-chip="">{chip}</span>
      ))}
    </span>
  );
}
