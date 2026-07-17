/**
 * Presentation-time cleanup for AI-popup / REVIEW responses.
 *
 * The stored `response` is a best-effort snapshot of a Claude Code TUI screen
 * (ANSI + box/Braille chrome already stripped by `cleanCapturedOutput` at
 * capture time — see `ansi.ts`). When the snapshot lands mid-startup it wraps
 * the real answer in shell scaffolding that always appears as a CONTIGUOUS
 * PREFIX — the echoed spawn command, its heredoc continuation lines, and the
 * CLI startup banner — optionally followed by a returned shell prompt.
 *
 * We strip only that leading block and a trailing prompt, and NEVER touch the
 * interior. Even at the boundary we bias hard AGAINST deleting real content
 * (an answer's own first/last line can resemble chrome): we strip a line only
 * when it is UNMISTAKABLE "strong" chrome, and treat the ambiguous "Welcome
 * back" greeting as "weak" — stripped only when it follows strong chrome in the
 * same leading block, never on its own (a fork-translate of the phrase would
 * look identical). This is why fork-explain answers that quote or discuss
 * `claude --resume … --fork-session …` keep those lines.
 *
 * Cleanup is NON-DESTRUCTIVE — the raw capture stays in IndexedDB and is one
 * "raw" toggle away. We do not try to repair the character-doubling a reflowed
 * terminal capture can introduce (`claude` → `cclaude`); that is unrecoverable.
 */

// zsh PS2 continuation prompts — echoed shell INPUT while a multi-line command
// is still being typed ("quote> …"). Only the zsh-internal state names that
// never begin ordinary prose or code are listed; the shell keywords that share
// a PS2 name (for/while/if/do…) are deliberately EXCLUDED so a code example is
// not mistaken for an echo.
const CONT_PROMPT_RE =
  /^\s*(?:quote|dquote|heredoc|cmdsubst|cursor|pipe|paren|bracket|brace|braces|math|subsh)>\s?/i;

// The echoed spawn command: a (possibly reflow-doubled) `claude` invocation
// carrying a launch flag, where `claude` is the COMMAND WORD — either at the
// start of the line, or right after a shell-prompt prefix (a line beginning with
// a %/$/~ sigil or an absolute/home path, up to the whitespace before `claude`).
// `#` is deliberately NOT a prompt sigil here: it is the markdown heading marker,
// so a heading like "# Using claude --resume …" must never be treated as chrome.
// This anchoring also keeps an answer sentence that merely mentions the flags
// mid-line (e.g. "the `--resume` flag reattaches…") from matching.
const SPAWN_CMD_RE =
  /^\s*(?:[%$~/][^\n]*\s)?c*claude\b[^\n]*--(?:fork-session|resume|remote-control|append-system-prompt)\b/i;

// A BARE shell prompt: the WHOLE line is a path + "(branch …)" segment ending in
// a %, $, or # sigil with nothing after it — a returned/waiting prompt. Anchored
// end-to-end so a line that merely *illustrates* a prompt is not chrome.
const BARE_PROMPT_RE = /^\s*[~/][^\n]*\([^)]*\)\s*[%$#]\s*$/;

// The Claude Code status wordmark line ("ClaudeCode", reflow often eats the
// space; a numeric status gutter may precede it). Whole-line anchored.
const WORDMARK_RE = /^\s*[\d\s]*claude\s?code!?\s*$/i;

// The "Welcome back[, <name>]!" greeting — indistinguishable from real prose, so
// treated as WEAK (see module doc). Whole-line anchored with a short name tail.
const GREETING_RE = /^\s*welcome\s?back[\s,.!]*\p{L}{0,20}!?\s*$/iu;

function isStrongChrome(line: string): boolean {
  return (
    CONT_PROMPT_RE.test(line) ||
    SPAWN_CMD_RE.test(line) ||
    BARE_PROMPT_RE.test(line) ||
    WORDMARK_RE.test(line)
  );
}

/**
 * Strip the leading shell-scaffolding block (and a trailing returned prompt)
 * from a captured response for display. Returns the readable answer — possibly
 * empty if the snapshot held only chrome.
 */
export function formatPopupResponse(raw: string): string {
  if (!raw) return '';
  const lines = raw.split('\n');

  // Consume the contiguous leading block: strong chrome + blank lines, plus the
  // weak "Welcome back" greeting ONLY once strong chrome has been seen in the
  // block. Stop at the first line that is real content.
  let start = 0;
  let sawStrong = false;
  while (start < lines.length) {
    const line = lines[start];
    if (line.trim() === '') {
      start++;
    } else if (isStrongChrome(line)) {
      sawStrong = true;
      start++;
    } else if (sawStrong && GREETING_RE.test(line)) {
      start++;
    } else {
      break;
    }
  }

  // Trim a trailing returned shell prompt + blank lines. Restricted to a BARE
  // prompt, so an answer that ENDS by discussing a flag or illustrating a prompt
  // is preserved.
  let end = lines.length - 1;
  while (end >= start && (lines[end].trim() === '' || BARE_PROMPT_RE.test(lines[end]))) {
    end--;
  }

  if (start > end) return '';
  return lines
    .slice(start, end + 1)
    .join('\n')
    .replace(/[ \t]+$/gm, '') // trailing whitespace per line
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
    .trim();
}
