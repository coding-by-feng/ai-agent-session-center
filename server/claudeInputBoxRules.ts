/**
 * @module claudeInputBoxRules
 * How Claude Code's input box is drawn, shared by the screen readers that look for it
 * (inputBoxCapture.ts, promptSuggestionCapture.ts).
 *
 *   ─────────────────────────────── Phonedesk ─   ← top rule: carries the session's `-n` name
 *   ❯ typed text
 *   ────────────────────────────────────────────   ← bottom rule: plain
 *
 * Claude Code 2.1.325 (tmux probe, Nov 16 2026) draws the `-n` name at the right end of the top rule,
 * followed by one ` ─`. Every Claude session the dashboard launches has a name (appendSessionName), so
 * a reader that wants a plain top rule never finds the box. A name too long for the row pushes every
 * leading dash out and is cut with `…`: ` Translate → 简体中文 · … th… ─`.
 */

/** A plain rule: the bottom of the box, or the top of an unnamed session's box. */
export const RULE_RE = /^\s*─{10,}\s*$/;

/**
 * The box's top rule: plain, or any dashes, then the session name, then ` ─` at the end.
 * Only ever tested on the row directly above a `❯` row (or as the first rule found going up from
 * the bottom rule), so a text row ending in ` ─` elsewhere on screen is never taken for it.
 */
export const TOP_RULE_RE = /^(?:\s*─{10,}\s*|\s*─*\s+\S.*\s─\s*)$/u;

/** The prompt glyph that starts the box's first row. */
export const PROMPT_RE = /^\s*[❯>]\s?/u;
