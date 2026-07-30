/**
 * @module sessionDisplayTitle
 * The one place that decides what a session card is called.
 *
 * `session.title` is intentionally empty until the first UserPromptSubmit — that
 * is what lets the auto-title (`buildAutoTitle`) fire exactly once, and it must
 * stay that way in the model. But a session can legitimately reach the UI before
 * (or without ever) recording a prompt: a hook-only external card, an adopted
 * terminal, a card whose first observed event was a PreToolUse. Rendering those
 * as a bare "Unnamed" throws away the one identifying fact we do have — the
 * project — and makes two unrelated sessions look like the same card.
 *
 * Dependency-free on purpose: imported by 2D list/sort code AND by the 3D robot
 * labels, so it must never pull Three.js into the eager bundle.
 */

/** The minimum a caller has to supply — anything Session-shaped satisfies it. */
export interface TitledSession {
  title?: string | null;
  projectName?: string | null;
}

/** Shown when a session has neither a title nor a project to fall back on. */
export const UNTITLED_SESSION_LABEL = 'Unnamed';

/**
 * Resolve the user-facing name of a session: explicit title, else the project
 * it runs in, else a last-resort placeholder. Always returns a non-empty string.
 */
export function sessionDisplayTitle(session: TitledSession | null | undefined): string {
  return session?.title?.trim()
    || session?.projectName?.trim()
    || UNTITLED_SESSION_LABEL;
}
