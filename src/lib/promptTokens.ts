/**
 * promptTokens.ts — which words of a queued prompt are skills or commands, for the
 * queue lists' highlight (Oct 21 2026, phone and desktop: PromptTokens).
 *
 * A token is `/name` — or `$name` on Codex, whose skills take that sigil (on Claude
 * `$` is ordinary text: $HOME, a price) — at the start of a word: after the start of
 * the text, a space or newline, or an opening bracket or quote. The name starts with
 * a letter and may hold `-`, `_`, digits and inner `.` / `:` (`/plugin:review-pr`).
 * It ends at a space, closing punctuation or the end; another `/` right after makes
 * it a path (`/Users/me/x`, `/tmp/…/a.png`), which stays plain, as does a slash
 * inside a word (`and/or`, a URL).
 */
export interface PromptRun {
  text: string;
  token: boolean;
}

const NAME = '[A-Za-z][\\w-]*(?:[.:][\\w-]+)*';
const OPENERS = '\\s(\\[{"\'“‘';
const TOKEN_RE: Record<'slash' | 'both', RegExp> = {
  slash: new RegExp(`(^|[${OPENERS}])(/${NAME})(?![\\w/$])`, 'g'),
  both: new RegExp(`(^|[${OPENERS}])([/$]${NAME})(?![\\w/$])`, 'g'),
};

/** `text` cut into plain runs and token runs, in order; joined back they are `text`. */
export function splitPromptTokens(text: string, cli: 'claude' | 'codex' | null): PromptRun[] {
  const runs: PromptRun[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN_RE[cli === 'codex' ? 'both' : 'slash'])) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > at) runs.push({ text: text.slice(at, start), token: false });
    runs.push({ text: match[2], token: true });
    at = start + match[2].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), token: false });
  return runs;
}
