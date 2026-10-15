/**
 * @module transcriptLocator
 * The one place that decides which file holds a session's conversation (AASC-49).
 *
 * Claude writes `~/.claude/projects/<encoded project>/<session id>.jsonl` (the hook reports it as
 * `transcriptPath`); Codex writes a rollout under `$CODEX_HOME/sessions` that only its session id
 * finds. A session reads its OWN file or nothing: never a neighbour's "newest .jsonl" in the same
 * project, and never the other CLI's folder. Callers already fall back to the in-memory logs.
 */
import { planCliOf, type CliHints } from '../planUsageCodec.js';

/** The CLIs whose conversation AASC can read from disk. */
export type TranscriptCli = 'claude' | 'codex';

/**
 * Which CLI's transcript a session has, or null for anything else. An explicit `cliSource` decides
 * (an unknown one, e.g. a Gemini session, means none); without it, the same launch-command / model /
 * event hints the plan-usage chip uses.
 */
export function transcriptCliOf(session: CliHints): TranscriptCli | null {
  const explicit = typeof session.cliSource === 'string' ? session.cliSource.trim().toLowerCase() : '';
  if (explicit === 'claude' || explicit === 'codex') return explicit;
  if (explicit) return null;
  return planCliOf(session);
}
