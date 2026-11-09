/**
 * terminalSearch.ts — the pure rules of find-in-terminal (Nov 6 2026): which key opens it,
 * what the count says, and the options handed to `@xterm/addon-search`.
 *
 * The whole scrollback is searchable because AASC runs Claude with its alternate screen off
 * and Codex with `--no-alt-screen`: their history lands in xterm's buffer. A program that
 * draws on the alternate screen (vim, less, a re-enabled fullscreen Claude) offers only what
 * is on screen.
 */
import type { ISearchOptions } from '@xterm/addon-search';

/** Typing searches after this pause, so a long scrollback is not scanned per keystroke. */
export const TERMINAL_SEARCH_DEBOUNCE_MS = 150;
/** The addon highlights at most this many matches and then reports index -1. */
export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1000;

/**
 * Highlight colours. The addon takes `#RRGGBB` only, so no theme variables; xterm's
 * minimum-contrast setting re-colours the text over them. Amber for every match, orange
 * for the current one. The addon also selects the current match, so the theme's selection
 * tint lies over its background; its thick outline (TerminalSearchBar.module.css) is what
 * makes it stand out.
 */
const DECORATIONS = {
  matchBackground: '#7a5c00',
  matchBorder: '#c99a1e',
  matchOverviewRuler: '#c99a1e',
  activeMatchBackground: '#d9650b',
  activeMatchBorder: '#ff8a2a',
  activeMatchColorOverviewRuler: '#ff8a2a',
} as const;

interface FindKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * ⌘F on a Mac, Ctrl+F elsewhere. On a Mac Ctrl+F stays the program's (readline's
 * forward-char); ⇧⌘F stays the session search.
 */
export function isTerminalFindKey(e: FindKey, isMac: boolean): boolean {
  if (e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export interface SearchResults {
  resultIndex: number;
  resultCount: number;
}

/**
 * "3/12", "No results"; at the highlight limit the addon stops counting, so the total
 * gets a "+" ("5/1000+"), and a current match past it shows the total alone ("1000+").
 * Empty before a query or an answer.
 */
export function formatMatchCount(query: string, results: SearchResults | null): string {
  if (!query || !results) return '';
  if (results.resultCount === 0) return 'No results';
  const total = results.resultCount >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT
    ? `${results.resultCount}+`
    : String(results.resultCount);
  if (results.resultIndex < 0) return total;
  return `${results.resultIndex + 1}/${total}`;
}

/** Does this regex compile? A bad one is shown, never searched (the addon would throw). */
export function isValidSearchRegex(query: string): boolean {
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

function supportsRegexModifiers(): boolean {
  try {
    new RegExp('(?i:a)');
    return true;
  } catch {
    return false;
  }
}
const REGEX_MODIFIERS = supportsRegexModifiers();

export interface SearchToggles {
  caseSensitive: boolean;
  regex: boolean;
}

/**
 * The term and options handed to the addon. Without Aa the addon lowercases the term and
 * the text, which for a regex also lowercases its escapes: `\S+` would become `\s+`. A
 * case-blind regex therefore goes as `(?i:…)` with the addon told to match case, where the
 * engine has inline modifiers (Chromium 125+, Node 24). A non-capturing group: group
 * numbers and back-references are unchanged.
 */
export function addonSearch(query: string, toggles: SearchToggles): { term: string; options: ISearchOptions } {
  const wrap = toggles.regex && !toggles.caseSensitive && REGEX_MODIFIERS;
  return {
    term: wrap ? `(?i:${query})` : query,
    options: {
      caseSensitive: wrap ? true : toggles.caseSensitive,
      regex: toggles.regex,
      decorations: { ...DECORATIONS },
    },
  };
}
