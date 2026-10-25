// test/mcp/resourceDefs.test.ts — the table of the 18 MCP resources (server/mcp/resourceDefs.ts): what the
// catalog lists, which tool backs each, which central is offered which, and which broadcast makes a subscriber read
// each one again. Pure: nothing here starts a server. How a URI is read is in resourceUri.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { allTools, MCP_MAX_PHASE, toolsFor } from '../../server/mcp/registry.js';
import { offerResources, RESOURCE_DEFS } from '../../server/mcp/resourceDefs.js';
import { ALL_TOOLSETS, CORE_TOOLSETS, type Toolset } from '../../server/mcp/types.js';
import { CATALOG_URIS } from './resourceWorld.js';

vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

/** What a central of these toolsets is given at this build. */
const toolsOf = (toolsets: readonly Toolset[]) =>
  toolsFor({ toolsets: [...toolsets] }, MCP_MAX_PHASE, allTools());
const offeredUris = (toolsets: readonly Toolset[]): string[] =>
  offerResources({ toolsets: [...toolsets] }, toolsOf(toolsets)).map((o) => o.def.uri);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the resource table', () => {
  it('holds the 18 resources of the catalog, in its order', () => {
    expect(RESOURCE_DEFS.map((d) => d.uri)).toEqual([...CATALOG_URIS]);
  });

  it('gives every resource its own name and a title and description to read', () => {
    expect(new Set(RESOURCE_DEFS.map((d) => d.name)).size).toBe(18);
    for (const d of RESOURCE_DEFS) {
      expect(d.title.trim(), d.name).not.toBe('');
      expect(d.description.trim().length, d.name).toBeGreaterThan(20);
    }
  });

  it('is backed by a registered read tool: a phase-1 one each, and task_get (P2) for a task (K3)', () => {
    const tools = new Map(allTools().map((t) => [t.name, t]));
    for (const d of RESOURCE_DEFS) {
      expect(d.tool, d.uri).not.toBeNull();
      const tool = tools.get(d.tool ?? '');
      expect(tool, `${d.uri} needs the tool ${d.tool}`).toBeDefined();
      expect(tool?.risk, d.uri).toBe('read');
      expect(tool?.phase, d.uri).toBe(d.uri === 'aasc://tasks/{taskId}' ? 2 : 1);
    }
  });

  it('reads a task by the id in its URI, as task_get takes it', () => {
    const task = RESOURCE_DEFS.find((d) => d.uri === 'aasc://tasks/{taskId}');

    expect(task?.args({ taskId: 'T12' })).toEqual({ id: 'T12' });
    expect(task?.description).toMatch(/task_get/);
    expect(task?.description).not.toMatch(/UNAVAILABLE|no task ledger/);
  });

  it('maps each resource to the tool the catalog names', () => {
    const toolOf = Object.fromEntries(RESOURCE_DEFS.map((d) => [d.uri, d.tool]));
    expect(toolOf).toEqual({
      'aasc://sessions': 'session_list',
      'aasc://sessions/{id}': 'session_get',
      'aasc://sessions/{id}/conversation': 'chat_read',
      'aasc://sessions/{id}/answer': 'chat_last_answer',
      'aasc://sessions/{id}/changes': 'changes_list',
      'aasc://sessions/{id}/changes/{fileIndex}': 'changes_diff',
      'aasc://sessions/{id}/terminal': 'terminal_output',
      'aasc://sessions/{id}/queue': 'queue_get',
      'aasc://sessions/{id}/subagents/{agentId}': 'subagent_transcript',
      'aasc://tasks/{taskId}': 'task_get',
      'aasc://rooms': 'room_list',
      'aasc://resources/{id}': 'resource_get',
      'aasc://resources/{id}/file': 'resource_read_file',
      'aasc://snippets': 'snippet_list',
      'aasc://history/{id}': 'history_get',
      'aasc://notes/media/{id}': 'note_media_get',
      'aasc://plan-usage': 'aasc_plan_usage',
      'aasc://workspace': 'aasc_workspace',
    });
  });

  it('says which broadcast makes a subscriber read each resource again', () => {
    const triggers = Object.fromEntries(RESOURCE_DEFS.map((d) => [d.uri, [...d.updatesOn]]));
    expect(triggers).toEqual({
      'aasc://sessions': ['session_update', 'session_removed'],
      'aasc://sessions/{id}': ['session_update', 'session_removed'],
      'aasc://sessions/{id}/conversation': ['chat_grew'],
      'aasc://sessions/{id}/answer': ['chat_grew'],
      'aasc://sessions/{id}/changes': ['chat_grew'],
      'aasc://sessions/{id}/changes/{fileIndex}': ['chat_grew'],
      'aasc://sessions/{id}/terminal': [],
      'aasc://sessions/{id}/queue': ['queue_update'],
      'aasc://sessions/{id}/subagents/{agentId}': ['session_update'],
      'aasc://tasks/{taskId}': [],
      // rooms_update never reaches the broadcast feed (roomsMirror sends it per device), so nothing can be pushed.
      'aasc://rooms': [],
      'aasc://resources/{id}': [],
      'aasc://resources/{id}/file': [],
      'aasc://snippets': ['snippets_update'],
      'aasc://history/{id}': [],
      'aasc://notes/media/{id}': [],
      'aasc://plan-usage': ['session_update'],
      'aasc://workspace': [],
    });
  });

  it('says honestly in the description of each resource that is never pushed that it is not', () => {
    for (const d of RESOURCE_DEFS.filter((r) => r.updatesOn.length === 0 && r.tool !== null)) {
      expect(d.description, d.uri).toMatch(/not pushed|does not change|no live updates/i);
    }
  });

  it('says of each resource the transcript feeds that its pushes follow what AASC reports and may lag', () => {
    const fed = RESOURCE_DEFS.filter((d) => d.updatesOn.includes('chat_grew'));

    expect(fed.map((d) => d.uri)).toEqual([
      'aasc://sessions/{id}/conversation',
      'aasc://sessions/{id}/answer',
      'aasc://sessions/{id}/changes',
      'aasc://sessions/{id}/changes/{fileIndex}',
    ]);
    for (const d of fed) {
      expect(d.description, d.uri).toMatch(/pushed when AASC reports that its transcript grew/i);
      expect(d.description, d.uri).toMatch(/may lag/i);
      expect(d.description, d.uri).toMatch(/re-read to be sure/i);
      // Not the promise it was: nothing says the transcript grew the moment it does.
      expect(d.description, d.uri).not.toMatch(/pushed when its transcript grows/i);
    }
  });

  it('gives the history resource the rule the history tool has: a running session in scope, an ended one in the central’s own folders', () => {
    const rule =
      'may open a running session only if it is in its scope, and an ended one only if it ran in its own folders.';
    const resource = RESOURCE_DEFS.find((d) => d.uri === 'aasc://history/{id}');
    const tool = allTools().find((t) => t.name === 'history_get');

    expect(resource?.description).toContain(rule);
    expect(tool?.description).toContain(rule);
    // A running session’s record grows: this is not one that “does not change”.
    expect(resource?.description).toMatch(/not pushed/i);
    expect(resource?.description).not.toMatch(/does not change/i);
  });

  it('says of the note media resource that it is the media’s description, and that the bytes are not available through MCP', () => {
    const resource = RESOURCE_DEFS.find((d) => d.uri === 'aasc://notes/media/{id}');

    expect(resource?.description).toMatch(/description of one image or video embedded in a note/i);
    expect(resource?.description).toMatch(/type, size and the session that owns it/i);
    expect(resource?.description).toMatch(/bytes are not available through MCP/i);
    expect(resource?.description).not.toMatch(/reads it|sends the file/i);
  });

  it('marks the resources about one session, and the one list of the sessions in scope', () => {
    const about = RESOURCE_DEFS.filter((d) => d.follows === 'session').map((d) => d.uri);
    expect(about).toEqual(CATALOG_URIS.filter((u) => u.startsWith('aasc://sessions/')));
    expect(RESOURCE_DEFS.filter((d) => d.follows === 'scope').map((d) => d.uri)).toEqual([
      'aasc://sessions',
    ]);
    // Everything else is the Mac's, or the account's: no session decides who may hear of it.
    expect(RESOURCE_DEFS.filter((d) => d.follows === 'account')).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Which resources a central is offered
// ---------------------------------------------------------------------------

describe('offerResources', () => {
  it('offers a Claude central, which has every toolset, all 18', () => {
    expect(offeredUris(ALL_TOOLSETS)).toEqual([...CATALOG_URIS]);
  });

  it('offers a Codex central, which has the core toolsets, 12: nothing from rooms, resources, saved prompts, history or notes', () => {
    const uris = offeredUris(CORE_TOOLSETS);
    expect(uris).toHaveLength(12);
    expect(CATALOG_URIS.filter((u) => !uris.includes(u))).toEqual([
      'aasc://rooms',
      'aasc://resources/{id}',
      'aasc://resources/{id}/file',
      'aasc://snippets',
      'aasc://history/{id}',
      'aasc://notes/media/{id}',
    ]);
  });

  it('adds what a room or project Codex central is given: rooms for one, resources and history for the other', () => {
    expect(offeredUris([...CORE_TOOLSETS, 'rooms'])).toHaveLength(13);
    expect(offeredUris([...CORE_TOOLSETS, 'rooms'])).toContain('aasc://rooms');
    const project = offeredUris([...CORE_TOOLSETS, 'resources', 'history']);
    expect(project).toHaveLength(15);
    expect(project).toEqual(
      expect.arrayContaining([
        'aasc://resources/{id}',
        'aasc://resources/{id}/file',
        'aasc://history/{id}',
      ]),
    );
    expect(project).not.toContain('aasc://rooms');
  });

  it('offers a resource only when its tool is one the central was given, and tasks only with the tasks toolset', () => {
    expect(offeredUris(['sessions'])).toEqual(['aasc://sessions', 'aasc://sessions/{id}']);
    expect(offeredUris(['tasks'])).toEqual(['aasc://tasks/{taskId}']);
    expect(offeredUris(['agenda'])).toEqual([]);
    expect(offeredUris([])).toEqual([]);
  });

  it('goes by the tools it is handed, so a later phase’s tool is no resource now', () => {
    const noQueue = toolsOf(ALL_TOOLSETS).filter((t) => t.name !== 'queue_get');
    const uris = offerResources({ toolsets: [...ALL_TOOLSETS] }, noQueue).map((o) => o.def.uri);
    expect(uris).toHaveLength(17);
    expect(uris).not.toContain('aasc://sessions/{id}/queue');
  });

  it('hands each resource its tool and an argument check built from that tool’s input', () => {
    for (const o of offerResources({ toolsets: [...ALL_TOOLSETS] }, toolsOf(ALL_TOOLSETS))) {
      expect(o.tool?.name ?? null, o.def.uri).toBe(o.def.tool);
      expect(o.check === null, o.def.uri).toBe(o.def.tool === null);
    }
  });
});
