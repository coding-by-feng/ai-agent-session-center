// tools/skillNoteWrite.ts — the skill-notes toolset's P3 writes: a skill's favourite flag, its tags and its
// abbreviation. Filed under `skillNotes` by skillNotes.ts's export line. (`skillnote_set_note` is not built: a skill
// note has no free text, Ruling P3-2.)
//
// The notes live in the AASC window on the Mac (and sync to the person's AASC Cloud account), so a change is a
// message to that window: `POST /api/skill-notes/ops` (server/skillNoteOpsRouter.ts) sends it to the workspace
// writer's window and waits up to 5 s for it to say it applied the change. 200 is applied, 202 is "not heard yet" (it
// may still be applied), 400 is the window's refusal as a fixed code (src/lib/skillNoteOps.ts), 409 is no window on
// the Mac. Each code becomes fixed words here, so nothing the window or its store says reaches a central (B-M5). The
// opId stays between the server and the window; it is in no answer here. Every rule a central must obey is in the description
// (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { z } from 'zod';
import type { InternalResponse } from '../client.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, plain, unwrap } from './define.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;
// A tag the window's normalizeTag keeps as it is (src/lib/skillNotes.ts): at most its MAX_TAG_CHARS (24), no `--`, no
// `-` at either end. Any other would be changed there, so the window refuses it.
const TAG_RE = /^(?!.*--)[a-z0-9_](?:[a-z0-9_-]{0,22}[a-z0-9_])?$/;
const TAG_CHARS_MAX = 24;
const ABBR_RE = /^[a-z0-9_-]{1,20}$/;
const TAGS_MAX = 10;

const AGENT = z.enum(['claude', 'codex', 'shared']).describe('Whose skill: claude, codex, or shared (the note applies to both).');
const NAME = z
  .string()
  .regex(NAME_RE)
  .describe('The skill or command name as skillnote_list or resource_list shows it (a plugin’s is plugin:name); up to 100 letters, digits and _ : . -.');

/** What every tool of the three says about waiting for the window. */
const WINDOW =
  'The change is applied by the AASC window on the Mac and syncs to AASC Cloud from there: with no AASC window open ' +
  'on the Mac the call answers NO_WINDOW. The name must be a skill or command the Library has for that agent ' +
  '(resource_list shows them): any other is NOT_FOUND, and nothing is changed, except a call that only clears or ' +
  'removes what that name’s existing note holds (favourite off, tags dropped, abbreviation null), so the note of an ' +
  'uninstalled skill can still be emptied. It answers applied: true when the ' +
  'window applied it, or applied: false with pending: true when the window did not answer within 5 s (it may still ' +
  'apply it: check skillnote_list before repeating).';

/** The window's own codes (src/lib/skillNoteOps.ts) and what a central does about each. */
function refusalFor(reason: string): ToolError {
  switch (reason) {
    case 'not-ready':
      return new ToolError('UNAVAILABLE', 'The skill notes in the AASC window are not loaded yet.', 'Try again in a few seconds.');
    case 'catalog-unavailable':
      return new ToolError('UNAVAILABLE', 'The AASC window could not read the Library to check the skill.', 'resource_rescan, then try again.');
    case 'unknown-skill':
      return new ToolError('NOT_FOUND', 'The Library has no skill or command of that agent with that name.', 'resource_list shows the names; check the agent too.');
    case 'bad-tags':
      return new ToolError(
        'INVALID',
        'The window cannot keep those tags as given.',
        `At most ${TAGS_MAX} tags, each 1 to ${TAG_CHARS_MAX} lowercase letters, digits, - or _, with no -- and no - at either end.`,
      );
    case 'abbr-format':
      return new ToolError(
        'INVALID',
        'That abbreviation is not 2 to 12 lowercase letters, digits, - or _ starting with a letter or digit.',
        'Choose one that is.',
      );
    case 'abbr-taken':
      return new ToolError('INVALID', 'Another skill already uses that abbreviation.', 'skillnote_list shows the abbreviations in use; choose another.');
    case 'abbr-shadows':
      return new ToolError('INVALID', 'That abbreviation is the name of a real skill or command.', 'Choose one that no skill or command is named.');
    case 'bad-op':
      return new ToolError('INVALID', 'The window did not understand the change.', 'Check the arguments in the tool’s input schema.');
    case 'failed':
      return new ToolError('UPSTREAM', 'The window could not apply the change.', 'Try once more; if it fails again, tell the person.');
    default:
      return new ToolError('INVALID', 'The window refused the change.', 'Check the arguments against the tool’s description.');
  }
}

function failureOf(answer: InternalResponse<unknown>): ToolError | null {
  if (answer.status === 409) {
    return new ToolError('NO_WINDOW', 'The AASC window on the Mac is closed.', 'Skill notes are changed by that window: ask the person to open AASC, then try again.');
  }
  if (answer.status === 404) {
    return new ToolError('UNAVAILABLE', 'This build of AASC cannot change skill notes.', 'Ask the person to update AASC.');
  }
  if (answer.status === 400) return refusalFor(answer.error ?? '');
  return null;
}

type Change = { fav?: boolean; tags?: string[]; abbr?: string | null };

/** Sends one change and answers what the route said: applied, or still pending. */
async function setNote(ctx: ToolContext, agent: string, name: string, set: Change, what: string): Promise<ToolResult> {
  const answer = await ctx.client.post('/skill-notes/ops', { agent, name, set });
  const refused = failureOf(answer);
  if (refused !== null) throw refused;
  const body = unwrap<unknown>(answer);
  const pending = isRecord(body) && body.applied === false;
  const key = plain(`${agent}:${name}`, 120);
  if (pending) {
    return {
      data: { applied: false, pending: true },
      summary: `The AASC window has not said it applied the change to ${key} yet (${what}); it may still apply it. skillnote_list shows what is set.`,
      activity: [{ summary: `asked the window to change skill note ${key}: ${what} (not confirmed)` }],
    };
  }
  return {
    data: { applied: true },
    summary: `Skill note ${key}: ${what}.`,
    activity: [{ summary: `changed skill note ${key}: ${what}` }],
  };
}

const setFavorite = defineTool({
  name: 'skillnote_set_favorite',
  toolset: 'skillNotes',
  title: 'Favourite a skill',
  description:
    'Marks a skill or command as a favourite (on: true) or not (on: false) in the person’s skill notes. A favourite already ' +
    `in that state is left as it is. ${WINDOW}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: { agent: AGENT, name: NAME, on: z.boolean().describe('true to make it a favourite, false to remove the star.') },
  run: (args, ctx) => setNote(ctx, args.agent, args.name, { fav: args.on }, args.on ? 'favourite on' : 'favourite off'),
});

const setTags = defineTool({
  name: 'skillnote_set_tags',
  toolset: 'skillNotes',
  title: 'Tag a skill',
  description:
    `Sets a skill or command’s tags: tags replaces the whole list (an empty list clears it), at most ${TAGS_MAX}, each 1 to ` +
    `${TAG_CHARS_MAX} lowercase letters, digits, - or _ with no -- and no - at either end (any other is INVALID, and ` +
    `nothing is changed). ${WINDOW}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    agent: AGENT,
    name: NAME,
    tags: z.array(z.string().regex(TAG_RE)).max(TAGS_MAX).describe('The tags the skill should have, replacing its current ones.'),
  },
  run: (args, ctx) => setNote(ctx, args.agent, args.name, { tags: args.tags }, `${args.tags.length} ${args.tags.length === 1 ? 'tag' : 'tags'}`),
});

const setAbbr = defineTool({
  name: 'skillnote_set_abbr',
  toolset: 'skillNotes',
  title: 'Abbreviate a skill',
  description:
    'Sets (or, with null, clears) a skill or command’s abbreviation: the short name the person types in AASC’s prompt box. ' +
    'The window refuses one that is not 2 to 12 lowercase letters, digits, - or _ starting with a letter or digit, that ' +
    'another skill of the same agent already uses, or that is the name of a real skill or command (it would shadow it): ' +
    `that is INVALID, saying which of the three. This changes AASC’s own note only; resource_alias_add makes the file the CLI reads. ${WINDOW}`,
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    agent: AGENT,
    name: NAME,
    abbr: z.string().regex(ABBR_RE).nullable().describe('The abbreviation, or null to clear it.'),
  },
  run: (args, ctx) => setNote(ctx, args.agent, args.name, { abbr: args.abbr }, args.abbr === null ? 'abbreviation cleared' : 'abbreviation set'),
});

export const skillNoteWriteTools: readonly ToolDef[] = [setFavorite, setTags, setAbbr];
