// tools/snippetWrite.ts — the saved-prompts toolset's P3 writes: `snippet_create` and `snippet_rename`. Filed under
// `snippets` by snippets.ts's export line. Both are `ask` tools: the library is the person's own, and what lands in it
// is later offered back to every central (snippet_use), so the person allows each change on the Mac first.
//
// `confirm` runs before any card and may refuse: a text that starts with `!` (the CLI would run it as a shell command,
// policy.ts `assertNotShellLine`), a text holding Unicode tag characters (invisible, and snippets are typed into CLIs)
// or a snippet id that does not exist never opens a card. The card shows `Name: <name or (no name)>` and the text the
// person is asked to save (the text cut so the whole card fits 2 000 characters, then how many more) or the old name
// and the new one. `run` runs only once the person allowed it, and checks both again: an approved call goes through
// the tool's own checks.
// The limits are the route's (`server/promptSnippets.ts`: 500 prompts of up to 64 KB, names up to 120 characters).
// Every rule a central must obey is in the description (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { z } from 'zod';
import { assertNotShellLine } from '../policy.js';
import type { ConfirmAsk, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, unwrap } from './define.js';
import { num, records, str } from './shape.js';

const TEXT_MAX = 64 * 1024;
const LABEL_MAX = 120;
/** The most of a text the card shows: the same cut the confirmation book makes of its detail. */
const CARD_TEXT_MAX = 2_000;
const NO_NAME = '(no name)';
/** Unicode tag characters: they render as nothing and can carry hidden instructions. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;

const WAITS = 'Waits for the person to allow it on the Mac (NEEDS_CONFIRMATION → confirm_wait).';

const LABEL = z.string().trim().max(LABEL_MAX).describe(`The prompt’s name, at most ${LABEL_MAX} characters.`);

/**
 * The card as it is shown: the name line, then the text whole up to what is left of 2 000 characters, else a head and
 * "… N more characters", the whole card within 2 000 so the book's own cut never takes the count away.
 */
function cardText(label: string | undefined, text: string): string {
  const header = `Name: ${label === undefined || label === '' ? NO_NAME : label}\n`;
  const room = Math.max(0, CARD_TEXT_MAX - header.length);
  if (text.length <= room) return header + text;
  const head = text.slice(0, Math.max(0, room - 30));
  return `${header}${head}… ${text.length - head.length} more characters`;
}

/** The text holds an invisible tag character: INVALID, in fixed words (the text is not repeated). */
function assertNoTagChars(text: string): void {
  if (TAG_CHARS.test(text)) {
    throw new ToolError(
      'INVALID',
      'The text holds invisible Unicode tag characters, which a saved prompt may not hold.',
      'Remove them and call the tool again.',
    );
  }
}

/** A 409 from the library routes: the person's library is full. */
function libraryFull(status: number, words: string | null): ToolError | null {
  if (status !== 409) return null;
  return new ToolError('INVALID', (words ?? 'The saved prompts are full.').slice(0, 200), 'Ask the person to remove a saved prompt first.');
}

const noSuchSnippet = (): ToolError => new ToolError('NOT_FOUND', 'No saved prompt has that id.', 'snippet_list shows the saved prompts and their ids.');

const snippetCreate = defineTool({
  name: 'snippet_create',
  toolset: 'snippets',
  title: 'Save a prompt',
  description:
    'Adds a prompt to the person’s saved-prompts library: text (up to 64 KB), with an optional name (up to 120 ' +
    'characters). A prompt the library already holds is not added twice: the answer says duplicate: true with its id. ' +
    'Text that starts with ! is refused (the CLI would run it as a shell command), and so is text holding ' +
    'invisible Unicode tag characters (U+E0000–E007F). The library holds 500 prompts. ' +
    `Save only what the person asked you to keep. ${WAITS}`,
  risk: 'ask',
  phase: 3,
  input: {
    text: z.string().trim().min(1).max(TEXT_MAX).describe('The prompt, up to 64 KB, not starting with !.'),
    label: LABEL.optional(),
  },
  confirm(args): ConfirmAsk {
    const text = args.text.trim();
    assertNotShellLine(text);
    assertNoTagChars(text);
    return { summary: 'add a saved prompt to your library', detail: cardText(args.label, text) };
  },
  async run(args, ctx) {
    const text = args.text.trim();
    assertNotShellLine(text);
    assertNoTagChars(text);
    const answer = await ctx.client.post('/snippets', { text, ...(args.label === undefined ? {} : { label: args.label }) });
    const full = libraryFull(answer.status, answer.error);
    if (full !== null) throw full;
    const body = unwrap<unknown>(answer);
    const raw = isRecord(body) ? body : {};
    const id = num(raw.id);
    if (id === null) throw new ToolError('UPSTREAM', 'AASC saved the prompt but did not say which.', 'snippet_list shows the saved prompts.');
    const duplicate = raw.duplicate === true;
    return {
      data: { id, duplicate },
      summary: duplicate ? `The library already holds that prompt, as #${id}; nothing was added.` : `Saved prompt #${id} added to the library.`,
      activity: [{ summary: duplicate ? `saved prompt #${id} already existed` : `added saved prompt #${id}`, detail: { snippetId: id } }],
    };
  },
});

const snippetRename = defineTool({
  name: 'snippet_rename',
  toolset: 'snippets',
  title: 'Rename a saved prompt',
  description:
    'Renames one of the person’s saved prompts: id is the number snippet_list shows after the # (an unknown id is ' +
    `NOT_FOUND), label the new name (up to 120 characters; empty clears it). The prompt’s text is not changed. ${WAITS}`,
  risk: 'ask',
  phase: 3,
  input: {
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('The saved prompt’s number, as snippet_list shows it (#3 is 3).'),
    label: LABEL,
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    const body = unwrap<unknown>(await ctx.client.get('/snippets'));
    const held = records(isRecord(body) ? body.snippets : undefined).find((s) => num(s.id) === args.id);
    if (held === undefined) throw noSuchSnippet();
    const old = str(held.label) ?? '';
    const next = args.label.trim();
    return { summary: 'rename a saved prompt', detail: `${old === '' ? NO_NAME : old} → ${next === '' ? NO_NAME : next}` };
  },
  async run(args, ctx) {
    const label = args.label.trim();
    const answer = await ctx.client.patch(`/snippets/${args.id}`, { label });
    if (answer.status === 404) throw noSuchSnippet();
    unwrap<unknown>(answer);
    return {
      data: { id: args.id, label },
      summary: label === '' ? `Saved prompt #${args.id} has no name now.` : `Saved prompt #${args.id} renamed.`,
      activity: [{ summary: `renamed saved prompt #${args.id}`, detail: { snippetId: args.id } }],
    };
  },
});

export const snippetWriteTools: readonly ToolDef[] = [snippetCreate, snippetRename];
