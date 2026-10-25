// tools/resourceRemove.ts — the resources toolset's P5 tools (Ruling P5-11): `resource_uninstall` moves a skill,
// command, rule, agent or memory file into the AASC trash, and `resource_restore` puts a trash entry back. Filed under
// `resources` by resources.ts's export line.
//
// A resource in ~/.claude or ~/.codex changes every project's sessions, so both are for a global central only, in
// resourceWrite.ts's words (`assertGlobal`). Uninstalling is `destructive`: it always waits for the person, and only the
// Mac can answer it (the phone never sees the card, P5-15). Before any card `confirm` reads the item (NOT_FOUND), asks
// the Library's own rule whether it may be uninstalled at all (`uninstallBlocker`: a plugin's, a link, a synced one…
// is DENIED) and checks `confirmName` against the item's name, case-sensitively: a mismatch is INVALID in fixed words
// that repeat neither name. The fingerprint is the item's id and a digest of its path (Ruling P5-3), so an item that
// moved after the card runs nothing. The route checks everything again (resourceCatalog.ts `assertUninstallable`) and
// these tools pass its refusals on in AASC's own fixed words: the route's words carry the display path and a plugin's or
// link's name, which come from the file system, so none of them is repeated (403 DENIED, 409 and 400 INVALID).
//
// Restoring is `write`: it undoes, and the route refuses to put an entry back where its folder now resolves elsewhere.
// Every rule a central must obey is in the description (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isUninstallableType, uninstallBlocker, type ResourceSummary } from '../../../src/types/resources.js';
import type { InternalResponse } from '../client.js';
import type { ConfirmAsk, ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, oneLine, plain, unwrap } from './define.js';
import { RESOURCE_ID } from './resourceFiles.js';
import { assertGlobal } from './resourceWrite.js';
import { str } from './shape.js';

/** `server/resourceUninstall.ts` `TRASH_ID_RE`: the route checks it again (a test holds the two together). */
const TRASH_ID_RE = /^\d{13}-[a-f0-9]{8}$/;
const NAME_MAX = 1_000;

const WHY_GLOBAL = 'a skill or command in ~/.claude or ~/.codex changes every project';
const GLOBAL_ONLY =
  'Skills, commands, rules, agents and memory in ~/.claude and ~/.codex change every project, so this is for a global ' +
  'central only (a room or project central is DENIED).';

const noSuchResource = (): ToolError =>
  new ToolError('NOT_FOUND', 'The Library has no resource with that id.', 'resource_list shows the Library and its ids; resource_rescan looks again.');

const notItsName = (): ToolError =>
  new ToolError('INVALID', 'That is not this resource’s name.', 'Pass confirmName exactly as resource_get shows the name: the case counts.');

/** The route's exact words for a wrong confirmName (resourceCatalog.ts `assertUninstallable`). */
const NAME_MISMATCH = 'Type the exact name to confirm';
/** The route's words for a move that copied into the trash but could not remove the original (resourceUninstall.ts). */
const PARTIAL_MOVE = /could not be fully removed/;
/** The 403 words of the uninstall route that carry nothing from the file system: the only ones passed on. */
const FIXED_403 = new Set([
  'Not a single folder or file — not removed here',
  'Outside the folder it was found in — not removed',
  'Credential files are never touched',
  'A link — not removed',
]);

const refusedPath = (): ToolError =>
  new ToolError('INVALID', 'AASC refused that resource’s path.', 'resource_list shows the Library; resource_rescan looks again.');

const changedSinceScan = (): ToolError =>
  new ToolError('INVALID', 'That resource changed since the last scan.', 'resource_rescan looks again; then call this once more.');

/** The original could not be fully removed, so the trash holds a complete copy: nothing to call again. */
const partialMove = (): ToolError =>
  new ToolError(
    'INVALID',
    'AASC copied the resource into its trash but could not fully remove the original.',
    'Tell the person: the AASC Library trash holds a complete copy.',
  );

/** The Library refused without a reason AASC can repeat (the route's text may hold a path or a name). */
const refusedByLibrary = (): ToolError =>
  new ToolError('DENIED', 'AASC refused to change that resource.', 'Tell the person; they can do it in AASC’s Library.');

const notRestorable = (): ToolError =>
  new ToolError(
    'INVALID',
    'AASC could not put that trash entry back: its place changed, or the entry is damaged.',
    'Tell the person; the AASC Library shows the trash and the place it came from.',
  );

/** The uninstall route's refusal as AASC's own fixed words, never the route's text. Null when it did not refuse. */
function uninstallRefusal(answer: InternalResponse<unknown>): ToolError | null {
  const said = answer.error ?? '';
  if (answer.status === 400) return said === NAME_MISMATCH ? notItsName() : refusedPath();
  if (answer.status === 404) return noSuchResource();
  if (answer.status === 403) {
    return FIXED_403.has(said) ? new ToolError('DENIED', said, 'Tell the person; AASC does not uninstall this kind of resource.') : refusedByLibrary();
  }
  if (answer.status === 409) return PARTIAL_MOVE.test(said) ? partialMove() : changedSinceScan();
  return null;
}

/** The restore route's refusal in fixed words: 404 NOT_FOUND, 403 DENIED, 409 INVALID. Null when it did not refuse so. */
function restoreRefusal(answer: InternalResponse<unknown>): ToolError | null {
  if (answer.status === 404) return new ToolError('NOT_FOUND', 'Nothing in the AASC trash has that id.', 'Use the trashId resource_uninstall answered.');
  if (answer.status === 403) return refusedByLibrary();
  if (answer.status === 409) return notRestorable();
  return null;
}

/** Why the Library will not uninstall this resource, in fixed words per origin (the blocker's own text names a plugin or a link target). */
function blockedWords(summary: ResourceSummary): string {
  if (!isUninstallableType(summary.type)) return 'Only skills, commands, rules, agents and memory can be uninstalled here.';
  if (summary.origin === 'plugin') return 'That resource is part of a plugin: remove the plugin instead.';
  if (summary.origin === 'system') return 'That resource is bundled with the CLI: an update would only put it back.';
  if (summary.origin === 'synced') return 'That resource is synced from claude.ai: remove it there.';
  if (summary.origin === 'linked') return 'That resource is a link to another folder, which owns it: remove it there.';
  return 'That resource is a link: remove the link by hand if that is what the person wants.';
}

/** The item as the Library holds it now: NOT_FOUND when it has none with this id. */
async function itemOf(ctx: ToolContext, id: string): Promise<ResourceSummary> {
  const answer = await ctx.client.get(`/resources/item/${id}`);
  if (answer.status === 404) throw noSuchResource();
  const body = unwrap<unknown>(answer);
  const summary = isRecord(body) && isRecord(body.summary) ? body.summary : null;
  if (summary === null || str(summary.name) === null || str(summary.path) === null) {
    throw new ToolError('UPSTREAM', 'AASC answered about that resource in a shape this build cannot read.', 'resource_get shows it; try once more.');
  }
  return summary as unknown as ResourceSummary;
}

/** The item's id and a digest of where it is: AASC-made and short, whatever the path (Ruling P5-3). */
const fingerprintOf = (summary: ResourceSummary): string =>
  `${summary.id}|${createHash('sha256').update(summary.path).digest('hex').slice(0, 40)}`;

const resourceUninstall = defineTool({
  name: 'resource_uninstall',
  toolset: 'resources',
  title: 'Uninstall a resource',
  description:
    'Moves one skill, command, rule, agent or memory file of the Library into the AASC trash; resource_restore with the ' +
    'trashId it answers brings it back. id is the resource’s id as resource_list shows it; confirmName must be its name ' +
    'exactly as resource_get shows it (the case counts), or it is INVALID. A plugin’s resource, one bundled with the ' +
    'CLI, one synced from claude.ai and a link are refused (DENIED): they are removed where they come from. ' +
    `${GLOBAL_ONLY} Uninstall only what the person asked you to. Always waits for the person to allow it on the Mac ` +
    '(NEEDS_CONFIRMATION → confirm_wait); if the resource moves before they do, nothing is done.',
  risk: 'destructive',
  phase: 5,
  input: {
    id: RESOURCE_ID,
    confirmName: z.string().min(1).max(NAME_MAX).describe('The resource’s name, exactly as resource_get shows it.'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    assertGlobal(ctx, 'uninstalls a resource', WHY_GLOBAL);
    const summary = await itemOf(ctx, args.id);
    const blocker = uninstallBlocker(summary);
    if (blocker !== null) throw new ToolError('DENIED', blockedWords(summary), 'Tell the person; AASC does not uninstall this kind of resource.');
    if (args.confirmName !== summary.name) throw notItsName();
    return {
      // The summary is written into the activity rows: the type and name as plain values only.
      summary: `uninstall the ${plain(summary.type, 20)} ${plain(summary.name, 80)} (moved to the AASC trash; resource_restore brings it back)`,
      detail: `From ${summary.path}`,
      fingerprint: fingerprintOf(summary),
    };
  },
  async run(args, ctx) {
    assertGlobal(ctx, 'uninstalls a resource', WHY_GLOBAL);
    const answer = await ctx.client.post(`/resources/item/${args.id}/uninstall`, { confirmName: args.confirmName });
    const refused = uninstallRefusal(answer);
    if (refused !== null) throw refused;
    const body = unwrap<unknown>(answer);
    const raw = isRecord(body) ? body : {};
    const trashId = str(raw.trashId);
    if (trashId === null || !TRASH_ID_RE.test(trashId)) {
      throw new ToolError('UPSTREAM', 'AASC moved the resource but did not say where in its trash.', 'Tell the person: AASC’s Library shows its trash.');
    }
    const name = str(raw.name) ?? '';
    const type = str(raw.type) ?? '';
    return {
      data: { trashId, name, type },
      summary: `Uninstalled the ${type} ${plain(name, 120)}: it is in the AASC trash as ${trashId}. resource_restore with that trashId brings it back.`,
      activity: [{ summary: `uninstalled a ${plain(type, 20)} into the AASC trash`, detail: { resourceId: args.id, trashId } }],
    };
  },
});

const resourceRestore = defineTool({
  name: 'resource_restore',
  toolset: 'resources',
  title: 'Restore an uninstalled resource',
  description:
    'Puts a resource that resource_uninstall moved into the AASC trash back where it was. trashId is the one ' +
    'resource_uninstall answered. Refused (INVALID) when the folder it came from now resolves somewhere else. ' +
    `${GLOBAL_ONLY} resource_rescan makes resource_list show it again.`,
  risk: 'write',
  phase: 5,
  input: {
    trashId: z.string().regex(TRASH_ID_RE).describe('The trash entry, as resource_uninstall answered it (13 digits, a dash, 8 hex).'),
  },
  async run(args, ctx) {
    assertGlobal(ctx, 'restores a resource', WHY_GLOBAL);
    const answer = await ctx.client.post(`/resources/trash/${args.trashId}/restore`, {});
    const refused = restoreRefusal(answer);
    if (refused !== null) throw refused;
    const body = unwrap<unknown>(answer);
    const raw = isRecord(body) ? body : {};
    const name = str(raw.name) ?? '';
    const type = str(raw.type) ?? '';
    const path = str(raw.path) ?? '';
    return {
      data: { name, type, path },
      summary: `Restored the ${type} ${plain(name, 120)} to ${oneLine(path, 300)}. resource_rescan makes resource_list show it again.`,
      activity: [{ summary: `restored a ${plain(type, 20)} from the AASC trash`, detail: { trashId: args.trashId } }],
    };
  },
});

export const resourceRemoveTools: readonly ToolDef[] = [resourceUninstall, resourceRestore];
