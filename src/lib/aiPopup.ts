/**
 * aiPopup — is the select-to-explain/translate popup on for a session?
 *
 * Pure and import-free so both the terminal UI and any future consumer read
 * the flag through the SAME rule. The whole reason this is a function rather
 * than an inline `session.aiPopupEnabled` check is the default:
 *
 *   undefined  → ENABLED   (a session that predates the toggle, or was just
 *                           created in memory before any DB read)
 *   true       → ENABLED
 *   false      → disabled  (only an explicit opt-out turns it off)
 *
 * Reading the raw field anywhere would make `undefined` falsy and silently
 * switch the feature off for every session that has never been toggled —
 * which is every session that exists today.
 *
 * Contrast `remoteVisible` (sessionVisibility.ts), where absent means HIDDEN.
 * Both follow "the absent state must be the safe state"; they differ because
 * the safe state differs. Remote visibility is a new capability, so its safe
 * default is deny. The AI popup already shipped on for everyone, so its safe
 * default — the one that changes nothing — is allow.
 */

/** The only field this module needs, so a Session, a DB row, or a test
 *  fixture all satisfy it structurally. */
export interface AiPopupCandidate {
  aiPopupEnabled?: boolean | null;
}

/** True unless the session has explicitly opted out. */
export function isAiPopupEnabled(session: AiPopupCandidate | null | undefined): boolean {
  // A missing session resolves to the default rather than false: the terminal
  // can render for a moment before its session record arrives, and flickering
  // the popup off during that window would be a worse lie than the default.
  if (!session) return true;
  return session.aiPopupEnabled !== false;
}
