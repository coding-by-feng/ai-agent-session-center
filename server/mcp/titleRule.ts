// titleRule.ts — the title rule (Ruling P3-23). A session's title is typed into its launch line as `-n "<title>"`, and
// the hook stores that launch back as the live CLI's `ps` args, where the quotes are gone: the title comes back as loose
// words, and every relaunch (resume, reconnect, fork, clone, a pinned respawn) types them again. So a title a central
// gives holds nothing a shell or the CLI reads as more than words:
//   - no shell syntax `; & | $ \` < > ( ) { } \`, no quote `' "`, no wildcard `* ? [ ]`, no control character or line
//     break (U+2028 and U+2029 included);
//   - no whitespace-separated word that starts with `-` (it would come back as a flag).
//
// An explicit title (session_set_title, session_fork's title, openWorker's title, which covers session_create) is
// refused with `titleRefusal`'s fixed words; a derived one (the router's `shortTitle` of a task, the folder's name) is
// put through `cleanTitle`, which answers a title that passes. Pure: it reads nothing but the text it is handed.

/** What every explicit title that breaks the rule is refused with; it never repeats the title. */
export const TITLE_REFUSAL =
  'A title holds no shell syntax, quotes, wildcards or line breaks, and no word of it starts with a dash.';

/** What a derived title falls back to when cleaning leaves nothing. */
export const CLEAN_TITLE_FALLBACK = 'New session';

/** Shell syntax, quotes and wildcards: removed by `cleanTitle`. */
const TITLE_SYNTAX = /[;&|$`<>(){}\\'"*?[\]]/;
/** Control characters and line breaks: a space in `cleanTitle`, so the words either side stay apart. */
// eslint-disable-next-line no-control-regex
const TITLE_BREAKS = /[\x00-\x1F\x7F\u2028\u2029]/;
/** A whitespace-separated word that starts with a dash. */
const DASH_WORD = /(?:^|\s)-/;

const everywhere = (re: RegExp): RegExp => new RegExp(re.source, 'g');

/** Why a central may not give this title; null when it may. */
export function titleRefusal(title: string): string | null {
  return TITLE_SYNTAX.test(title) || TITLE_BREAKS.test(title) || DASH_WORD.test(title) ? TITLE_REFUSAL : null;
}

/** `text` as a title that passes the rule: the characters removed, the words' leading dashes stripped, one space apart. */
export function cleanTitle(text: string): string {
  const words = text
    .replace(everywhere(TITLE_BREAKS), ' ')
    .replace(everywhere(TITLE_SYNTAX), '')
    .split(/\s+/)
    .map((word) => word.replace(/^-+/, ''))
    .filter((word) => word !== '');
  return words.length > 0 ? words.join(' ') : CLEAN_TITLE_FALLBACK;
}
