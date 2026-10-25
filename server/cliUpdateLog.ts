/**
 * @module cliUpdateLog
 * An agent CLI update's live log (Oct 26 2026): what `claude update` / `codex update` prints, as the
 * lines Settings ▸ ADVANCED ▸ Agent CLIs shows under the CLI's row while it runs and after it ends.
 *
 * Chunks arrive split anywhere, so each stream keeps its own unfinished line. A bare `\r` (a progress
 * counter redrawing itself) overwrites the line instead of adding one; a `\r\n` split across two
 * chunks still ends the line. Lines are ANSI-stripped, home-masked (they go to every device) and
 * capped; only the newest `keep` are returned.
 */
import { stripAnsi } from '../src/lib/ansi.js';

/** The longest line kept. */
export const UPDATE_LOG_LINE_CAP = 300;
/** An unfinished line never grows past this (a stream that never prints a newline). */
const PENDING_CAP = UPDATE_LOG_LINE_CAP * 4;
// Control characters left after ANSI is stripped (backspace, bell…); tab and newline are handled apart.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const TOKEN_RE = /\r\n|\r|\n|[^\r\n]+/g;

export type UpdateStream = 'stdout' | 'stderr';

export interface UpdateLog {
  push(stream: UpdateStream, chunk: string): void;
  /** The newest lines, oldest first: a new array every call. */
  lines(): string[];
}

interface Pending {
  text: string;
  /** A `\r` arrived last: the next text overwrites the line, the next `\n` ends it. */
  cr: boolean;
}

export function createUpdateLog(keep: number, mask: (text: string) => string): UpdateLog {
  let done: string[] = [];
  const pending: Record<UpdateStream, Pending> = { stdout: { text: '', cr: false }, stderr: { text: '', cr: false } };

  const clean = (raw: string): string => mask(stripAnsi(raw).replace(CONTROL_RE, '').trimEnd()).slice(0, UPDATE_LOG_LINE_CAP);

  const commit = (line: string) => {
    done = [...done, line];
    // Raw lines may still be blank, so keep some slack over `keep` before trimming.
    if (done.length > keep * 4) done = done.slice(-keep * 2);
  };

  return {
    push(stream, chunk) {
      let { text, cr } = pending[stream];
      for (const token of chunk.match(TOKEN_RE) ?? []) {
        if (token === '\n' || token === '\r\n') {
          commit(text);
          text = '';
          cr = false;
        } else if (token === '\r') {
          if (cr) text = '';
          cr = true;
        } else {
          if (cr) text = '';
          cr = false;
          text = (text + token).slice(-PENDING_CAP);
        }
      }
      pending[stream] = { text, cr };
    },
    lines() {
      return [...done, pending.stdout.text, pending.stderr.text].map(clean).filter(Boolean).slice(-keep);
    },
  };
}
