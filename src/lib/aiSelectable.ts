/**
 * aiSelectable — the attribute that marks a surface whose selected text a
 * phone's AI popup reads (`[data-ai-selectable="<scope id>"]`, AASC-20).
 *
 * On its own, import-free, so ConversationView can mark its root without
 * pulling the phone's selection hook (hooks/useSelectionIn) into the entry
 * chunk (AASC-31).
 */
export const SELECTABLE_ATTR = 'data-ai-selectable';
