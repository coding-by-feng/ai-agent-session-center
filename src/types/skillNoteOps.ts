/**
 * A skill-note change a central asked for (POST /api/skill-notes/ops), sent to the workspace writer's window
 * as `skill_note_op`; the window applies it to its skill-note store and answers with a `SkillNoteOpResult`.
 * Shared by the server and the client, so the two cannot drift.
 */
export const SKILL_NOTE_OP = 'skill_note_op' as const;
export interface SkillNoteChange { fav?: boolean; tags?: string[]; abbr?: string | null }
export interface SkillNoteOpMessage { type: typeof SKILL_NOTE_OP; opId: string; key: string; set: SkillNoteChange }
export interface SkillNoteOpResult { ok: boolean; error?: string }
