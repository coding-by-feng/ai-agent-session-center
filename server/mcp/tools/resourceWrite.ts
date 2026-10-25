// tools/resourceWrite.ts — the resources toolset's P3 writes: `resource_rescan` (look through the Library again) and
// the abbreviation commands `resource_alias_add` / `resource_alias_remove`. Filed under `resources` by resources.ts's
// export line.
//
// An alias is a small file AASC makes in `~/.claude/commands` or `~/.codex` so that typing `/rar` (Claude) or `$rar`
// (Codex) runs a skill or command in the CLI itself. It changes how every project's sessions behave, so only a global
// central may write one (Ruling P3-14). The route does the real work and every refusal (`server/resourceAliases.ts`:
// AASC only ever creates, replaces or deletes a file it made; a hand-written file or a symlink is left alone); these
// tools pass its answer on. Paths in an answer are the route's display paths (`~/…`), AASC's words. Every rule a
// central must obey is in the description (Ruling 65), and what it acts on is in `data` (Ruling 66).

import { z } from 'zod';
import type { InternalResponse } from '../client.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, plural, unwrap } from './define.js';
import { records, str } from './shape.js';

/** `server/resourceAliases.ts` `ABBR_RE` and `TARGET_RE`: the route checks them again. */
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{1,11}$/;
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ROUTE_WORDS_MAX = 200;

const AGENT = z.enum(['claude', 'codex']).describe('The CLI whose command the alias is: claude (typed /alias) or codex (typed $alias for a skill).');
const KIND = z.enum(['skill', 'command']).describe('What the alias stands for: a skill or a command.');
const ALIAS = z
  .string()
  .regex(ALIAS_RE)
  .describe('The short name, 2 to 12 lowercase letters, digits, - or _, starting with a letter or digit. It may not be the name of a real skill or command.');

const GLOBAL_ONLY = 'Aliases are files in the person’s ~/.claude and ~/.codex that every project reads, so this is for a global central only (a room or project central is DENIED).';

/**
 * DENIED unless the caller is a global central (Ruling P3-14): `doing` says what only it does, `why` why. Shared with
 * resourceRemove.ts (P5-11), whose uninstall and restore are global-only for the same reason.
 */
export function assertGlobal(ctx: ToolContext, doing = 'writes abbreviation commands', why = 'an alias changes every project'): void {
  if (ctx.central.kind !== 'global') {
    throw new ToolError('DENIED', `Only a global central ${doing}.`, `Ask the global central, or the person: ${why}.`);
  }
}

/** The files an alias answer lists: display path and what was done to it. */
function filesOf(body: unknown): Array<{ path: string; action: string }> {
  const files = isRecord(body) ? records(body.files) : [];
  return files.map((f) => ({ path: str(f.path) ?? '', action: str(f.action) ?? '' }));
}

/** A 409 is the route refusing for a reason of the Library (not in the catalog, shadowing, a file of the person's own). */
function aliasFailure(answer: InternalResponse<unknown>): ToolError | null {
  if (answer.status !== 409) return null;
  const words = (answer.error ?? '').slice(0, ROUTE_WORDS_MAX);
  return new ToolError('INVALID', words === '' ? 'AASC refused the abbreviation.' : words, 'resource_rescan refreshes the Library; resource_list shows the real names.');
}

function fileLines(files: ReadonlyArray<{ path: string; action: string }>): string {
  return files.length === 0 ? '' : ` ${files.map((f) => `${f.action} ${f.path}`).join('; ')}.`;
}

const resourceRescan = defineTool({
  name: 'resource_rescan',
  toolset: 'resources',
  title: 'Rescan the Library',
  description:
    'Starts a new scan of the Library of skills, commands, rules, memory, agents, hooks, MCP servers and plugins on this ' +
    'Mac. Answers at once with the scan state and its progress: the scan runs on in the background and joins one that is ' +
    'already running. Ask resource_list again in a few seconds for the new list.',
  risk: 'write',
  phase: 3,
  input: {},
  async run(_args, ctx) {
    const body = unwrap<unknown>(await ctx.client.post('/resources/scan', {}));
    const raw = isRecord(body) ? body : {};
    const state = str(raw.state) ?? 'idle';
    const progress = isRecord(raw.progress)
      ? { phase: str(raw.progress.phase) ?? '', done: Number(raw.progress.done) || 0, total: Number(raw.progress.total) || 0 }
      : undefined;
    return {
      data: { state, scanning: state === 'scanning', ...(progress === undefined ? {} : { progress }) },
      summary:
        state === 'scanning'
          ? 'A scan of the Library is running. Ask resource_list again in a few seconds for the new list.'
          : `The Library scan is ${state}. resource_list shows the list.`,
      activity: [{ summary: 'started a Library rescan' }],
    };
  },
});

const resourceAliasAdd = defineTool({
  name: 'resource_alias_add',
  toolset: 'resources',
  title: 'Add an abbreviation command',
  description:
    'Makes (or updates) an abbreviation command: a small file AASC writes in ~/.claude/commands (Claude, typed /alias) or ' +
    '~/.codex (Codex), so the short name runs a real skill or command inside the CLI. target is the skill or command’s ' +
    'name as resource_list shows it (a plugin’s is plugin:name) and must be in the Library; alias may not be the name of ' +
    'a real skill or command. AASC never overwrites a file it did not make: that is refused. ' +
    `${GLOBAL_ONLY} Add one only when the person asked for it.`,
  risk: 'write',
  phase: 3,
  input: {
    agent: AGENT,
    kind: KIND,
    alias: ALIAS,
    target: z.string().regex(TARGET_RE).describe('The skill or command it stands for, by name (a plugin’s is plugin:name).'),
  },
  async run(args, ctx) {
    assertGlobal(ctx);
    const answer = await ctx.client.post('/resources/aliases', { agent: args.agent, kind: args.kind, abbr: args.alias, target: args.target });
    const refused = aliasFailure(answer);
    if (refused !== null) throw refused;
    const files = filesOf(unwrap<unknown>(answer));
    return {
      data: { files },
      summary: `Abbreviation ${args.alias} for ${args.agent} ${args.kind} ${args.target}: ${plural(files.length, 'file')}.${fileLines(files)}`,
      activity: [{ summary: `added abbreviation command ${args.alias} (${args.agent} ${args.kind})` }],
    };
  },
});

const resourceAliasRemove = defineTool({
  name: 'resource_alias_remove',
  toolset: 'resources',
  title: 'Remove an abbreviation command',
  description:
    'Removes an abbreviation command: the file AASC made for it in ~/.claude/commands or ~/.codex. A file AASC did not ' +
    `make is kept and reported as kept. ${GLOBAL_ONLY} Remove one only when the person asked for it.`,
  risk: 'write',
  phase: 3,
  input: { agent: AGENT, kind: KIND, alias: ALIAS },
  async run(args, ctx) {
    assertGlobal(ctx);
    const answer = await ctx.client.del('/resources/aliases', { agent: args.agent, kind: args.kind, abbr: args.alias });
    const refused = aliasFailure(answer);
    if (refused !== null) throw refused;
    const files = filesOf(unwrap<unknown>(answer));
    return {
      data: { files },
      summary: `Abbreviation ${args.alias} (${args.agent} ${args.kind}): ${plural(files.length, 'file')}.${fileLines(files)}`,
      activity: [{ summary: `removed abbreviation command ${args.alias} (${args.agent} ${args.kind})` }],
    };
  },
});

export const resourceWriteTools: readonly ToolDef[] = [resourceRescan, resourceAliasAdd, resourceAliasRemove];
