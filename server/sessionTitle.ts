/**
 * Pure session-title helpers — no DB / native-module imports so this file can be
 * unit-tested in Vitest without tripping the better-sqlite3 ABI worker crash that
 * importing sessionStore.ts triggers.
 *
 * Used by sessionStore.ts to auto-generate a session title from the first user
 * prompt, and to detect the static "Clone of …" / "Fork of …" template titles so
 * cloned/forked sessions can be re-titled from their own context on first use.
 */

/**
 * Extract a short title from a prompt: drops a single leading polite prefix,
 * keeps the first sentence/line up to ~60 chars, and capitalizes it.
 * Returns '' for empty/uninformative input.
 */
export function makeShortTitle(prompt: string): string {
  if (!prompt) return '';
  // Strip leading whitespace and a single common prefix
  let text = prompt.trim().replace(/^(please|can you|could you|help me|i want to|i need to)\s+/i, '');
  if (!text) return '';
  // Take first sentence (up to . ! ? or newline)
  const match = text.match(/^[^\n.!?]{1,60}/);
  if (match) text = match[0].trim();
  if (!text) return '';
  // Capitalize first letter
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The static titles the dashboard bakes into a clone/fork at spawn time
 * (apiRouter.ts: `Clone of ${…}` / `Fork of ${…}`). Matched case-sensitively so
 * only the generated template — never a user's manual rename — is replaceable.
 */
const CLONE_FORK_TEMPLATE_RE = /^(?:Clone|Fork) of /;

/**
 * True when `title` still carries the auto-generated "Clone of …" / "Fork of …"
 * template, i.e. the session has not yet been re-titled from its own context and
 * has not been manually renamed. Used to gate a one-shot auto-rename.
 */
export function isCloneForkTemplateTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return CLONE_FORK_TEMPLATE_RE.test(title);
}

/**
 * Build the canonical auto-title `"<project> #<n> — <short prompt>"`, falling
 * back to `"<project> — Session #<n>"` when the prompt yields no usable summary.
 * Format must stay byte-identical to the value sessionStore previously inlined.
 */
export function buildAutoTitle(projectName: string, counter: number, prompt: string): string {
  const shortPrompt = makeShortTitle(prompt);
  return shortPrompt
    ? `${projectName} #${counter} — ${shortPrompt}`
    : `${projectName} — Session #${counter}`;
}
