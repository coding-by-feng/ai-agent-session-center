// tools/central.ts — the two system tools that are about centrals: what this central can reach (`scope_get`) and
// which centrals run (`central_list`). Read only; neither calls a route. scope_get also carries the playbook of the
// central's kind (instructions.ts), for a CLI that never shows a server's instructions to its model (Codex).
//
// `ctx.centrals()` is the registry's whole list, so `central_list` cuts it to what the caller may know of: a
// global central sees every central, any other sees only itself (another one's room id or project folder is
// outside its scope). Output is built field by field, never by copying a record, so a token cannot ride along
// whatever the record holds.

import { centralInstructions } from '../instructions.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { MCP_MAX_PHASE, type CentralKind } from '../types.js';
import { defineTool, fence, plural, visibleRooms } from './define.js';
import { ago } from './views.js';

/** What a central's scope is called: its room's name, its project folder, or nothing for a global one. */
function scopeNameOf(kind: CentralKind, scopeRef: string | null, roomNames: ReadonlyMap<string, string>): string | null {
  if (kind === 'room') return scopeRef === null ? null : (roomNames.get(scopeRef) ?? null);
  return kind === 'project' ? scopeRef : null;
}

const roomNamesOf = (ctx: ToolContext): Map<string, string> => new Map(visibleRooms(ctx).map((r) => [r.id, r.name]));

// ---------------------------------------------------------------------------
// scope_get
// ---------------------------------------------------------------------------

const REACH: Record<CentralKind, string> = {
  global: 'You are the global central: you can see and reach every session.',
  room: 'You are a room central: you can see and reach only the sessions of your own room.',
  project: 'You are a project central: you can see and reach only the sessions whose folder is your project folder or below it.',
};

const scopeGet = defineTool({
  name: 'scope_get',
  toolset: 'system',
  title: 'My scope',
  description:
    'Says what this central is and what it can reach: its kind (global, room or project), its room or folder, its ' +
    'toolsets, and how many sessions are in its scope now. Sessions outside it answer NOT_IN_SCOPE. Its data also ' +
    'includes how to work as a central (playbook): read it when you start.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const { centralId, kind, scopeRef, cli, permissionMode, toolsets } = ctx.central;
    const inScope = ctx.scopedSessions().filter((s) => !s.isFloating);
    const live = inScope.filter((s) => s.status !== 'ended');
    const scopeName = scopeNameOf(kind, scopeRef, roomNamesOf(ctx));
    const data = {
      centralId,
      kind,
      scopeRef,
      scopeName,
      cli,
      permissionMode,
      toolsets: [...toolsets],
      inScopeCount: inScope.length,
      liveCount: live.length,
      playbook: centralInstructions(kind, MCP_MAX_PHASE),
    };
    const named = scopeName === null ? [] : [`Your ${kind === 'room' ? 'room' : 'folder'}: ${fence('aasc', 'scope-name', scopeName)}`];
    const lines = [
      REACH[kind],
      ...named,
      `${plural(inScope.length, 'session')} in scope now (${live.length} live).`,
      `Toolsets: ${toolsets.join(', ')}.`,
    ];
    return { data, summary: lines.join('\n') };
  },
});

// ---------------------------------------------------------------------------
// central_list
// ---------------------------------------------------------------------------

const centralList = defineTool({
  name: 'central_list',
  toolset: 'system',
  title: 'List centrals',
  description:
    'Lists the centrals that run now, oldest first: kind, room or folder, CLI, toolsets, when each started and ' +
    'the session it runs in. A global central sees them all; a room or project central sees only itself.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const you = ctx.central.centralId;
    const all = ctx.centrals();
    const visible = ctx.central.kind === 'global' ? all : all.filter((c) => c.centralId === you);
    const names = roomNamesOf(ctx);
    const cards = ctx.sessions();
    const centrals = visible.map((c) => {
      const card = cards.find((s) => s.central?.centralId === c.centralId);
      return {
        centralId: c.centralId,
        kind: c.kind,
        scopeRef: c.scopeRef,
        scopeName: scopeNameOf(c.kind, c.scopeRef, names),
        cli: c.cli,
        toolsets: [...c.toolsets],
        permissionMode: c.permissionMode,
        createdAt: c.createdAt,
        sessionId: card?.sessionId ?? null,
        shortId: card === undefined ? null : shortIdOf(card.sessionId),
        isYou: c.centralId === you,
      };
    });
    const data = { count: centrals.length, centrals };
    if (centrals.length === 0) return { data, summary: 'No central is running.' };
    const now = ctx.now();
    const rows = centrals.map((c) => {
      const scope = c.kind === 'global' ? 'everything' : JSON.stringify(c.scopeName ?? c.scopeRef ?? 'unknown');
      const card = c.shortId === null ? 'no session yet' : `session ${c.shortId}`;
      return `${c.kind} central · ${scope} · ${c.cli} · ${plural(c.toolsets.length, 'toolset')} · started ${ago(now - c.createdAt)} · ${card}${c.isYou ? ' · you' : ''}`;
    });
    const lead = `${plural(centrals.length, 'central')} ${centrals.length === 1 ? 'is' : 'are'} running (you are the ${ctx.central.kind} central).`;
    return { data, summary: `${lead}\n${fence('aasc', 'session-cards', rows.join('\n'))}` };
  },
});

export const centralTools: readonly ToolDef[] = [scopeGet, centralList];
