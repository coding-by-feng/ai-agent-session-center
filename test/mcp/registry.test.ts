// test/mcp/registry.test.ts — which tools a central is given (server/mcp/registry.ts, with the per-toolset
// lists in server/mcp/tools/index.ts) and the playbook it reads at initialize (server/mcp/instructions.ts).
//
// The registry checks run over whatever tools are filed today, so they hold the tool modules Tasks 8-9 add
// to the same rules: one toolset each, a unique name, a phase, a risk.
import { describe, expect, it, vi } from 'vitest';
import { centralInstructions } from '../../server/mcp/instructions.js';
import { defaultToolsets } from '../../server/mcp/centrals.js';
import { allTools, confirmRuleViolations, MCP_MAX_PHASE, toolsFor, type ToolDef } from '../../server/mcp/registry.js';
import { toolsByToolset } from '../../server/mcp/tools/index.js';
import { ALL_TOOLSETS, type CentralKind, type Toolset } from '../../server/mcp/types.js';

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

const RISKS = ['read', 'write', 'steers', 'ask', 'destructive', 'outward'];

function tool(name: string, toolset: Toolset, phase: ToolDef['phase']): ToolDef {
  return {
    name,
    toolset,
    title: name,
    description: name,
    risk: 'read',
    phase,
    input: {},
    run: async () => ({ data: null, summary: name }),
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('session_list', 'sessions', 1),
  tool('session_create', 'sessions', 3),
  tool('room_list', 'rooms', 1),
  tool('aasc_health', 'system', 1),
  tool('prompt_send', 'prompts', 2),
  tool('cloud_publish', 'cloud', 6),
]);

describe('toolsFor', () => {
  it("keeps the tools of the central's toolsets, up to the phase", () => {
    const central = { toolsets: ['sessions', 'system', 'prompts'] as Toolset[] };

    expect(toolsFor(central, 1, TOOLS).map((t) => t.name)).toEqual(['session_list', 'aasc_health']);
    expect(toolsFor(central, 3, TOOLS).map((t) => t.name)).toEqual([
      'session_list',
      'session_create',
      'aasc_health',
      'prompt_send',
    ]);
    expect(toolsFor({ toolsets: [...ALL_TOOLSETS] }, 6, TOOLS)).toHaveLength(TOOLS.length);
  });

  it('gives a central with no toolsets nothing', () => {
    expect(toolsFor({ toolsets: [] }, 6, TOOLS)).toEqual([]);
  });

  it('answers a new list and leaves the one it was given alone', () => {
    const given = [...TOOLS];
    const kept = toolsFor({ toolsets: [...ALL_TOOLSETS] }, 6, given);

    expect(kept).not.toBe(given);
    expect(given).toEqual(TOOLS);
  });

  it('reads the registered tools when it is given none', () => {
    expect(toolsFor({ toolsets: [...ALL_TOOLSETS] }, 6)).toEqual(allTools());
  });
});

describe('the tool registry', () => {
  it('exposes the tools of P1 to P6, and none of a later phase, in this build', () => {
    expect(MCP_MAX_PHASE).toBe(6);
    expect(allTools().filter((t) => t.phase > MCP_MAX_PHASE)).toEqual([]);
    for (const phase of [1, 2, 3, 4, 5, 6]) expect(allTools().some((t) => t.phase === phase), String(phase)).toBe(true);
    const p6 = allTools().filter((t) => t.phase === 6);
    expect(p6.every((t) => t.toolset === 'cloud')).toBe(true);
    expect(p6.map((t) => t.name).sort()).toEqual([
      'cloud_aliases_preview', 'cloud_aliases_reconcile', 'cloud_install_plan', 'cloud_install_restore',
      'cloud_install_run', 'cloud_job_cancel', 'cloud_job_get', 'cloud_job_retry', 'cloud_project_associate',
      'cloud_project_check', 'cloud_project_create', 'cloud_project_get_copy', 'cloud_project_pull', 'cloud_project_push',
      'cloud_project_remove', 'cloud_project_resources_plan', 'cloud_project_retry_resources', 'cloud_project_set_account',
      'cloud_project_update', 'cloud_publish_plan', 'cloud_publish_run', 'cloud_recheck', 'cloud_sync_now',
      'cloud_sync_set', 'remote_access_refresh',
    ]);
    const risks = (want: string) => p6.filter((t) => t.risk === want).length;
    expect([risks('read'), risks('write'), risks('outward'), risks('destructive')]).toEqual([1, 15, 8, 1]);
    expect(
      allTools()
        .filter((t) => t.phase === 5)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'agenda_delete', 'history_delete', 'note_delete', 'queue_clear', 'resource_restore', 'resource_uninstall',
      'session_close', 'session_interrupt', 'session_kill', 'session_restart', 'snippet_delete',
    ]);
    expect(
      allTools()
        .filter((t) => t.phase === 3 || t.phase === 4)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'aasc_set_keep_awake', 'agenda_add', 'agenda_toggle', 'agenda_update', 'confirm_wait', 'key_send', 'note_add',
      'note_attach_media', 'note_update', 'project_resolve', 'resource_alias_add', 'resource_alias_remove',
      'resource_rescan', 'room_create', 'room_delete', 'room_move_session', 'room_rename', 'room_reorder',
      'room_set_color', 'session_clone', 'session_create', 'session_fork', 'session_reconnect', 'session_resume',
      'session_set_accent_color', 'session_set_ai_popup', 'session_set_alerted', 'session_set_character_model',
      'session_set_effort', 'session_set_model', 'session_set_muted', 'session_set_pinned', 'session_set_remark',
      'session_set_shared', 'session_set_title', 'session_summarize', 'skillnote_set_abbr', 'skillnote_set_favorite',
      'skillnote_set_tags', 'snippet_create', 'snippet_rename', 'task_route', 'terminal_clear',
    ]);
  });

  it('every ask tool defines confirm', () => {
    expect(allTools().filter((t) => t.risk === 'ask').length).toBeGreaterThan(0);
    expect(confirmRuleViolations(allTools())).toEqual([]);
  });

  it('every ask, destructive and outward tool defines confirm', () => {
    const waiting = allTools().filter((t) => t.risk === 'ask' || t.risk === 'destructive' || t.risk === 'outward');
    expect(waiting.filter((t) => t.risk === 'destructive').length).toBe(11);
    expect(waiting.filter((t) => t.risk === 'outward').length).toBe(8);
    for (const t of waiting) expect(typeof t.confirm, t.name).toBe('function');
  });

  it('a Claude central lists 163 tools for every kind; a Codex central lists 83 (global), 90 (room) and 100 (project)', () => {
    for (const kind of ['global', 'room', 'project'] as const) {
      expect(toolsFor({ toolsets: defaultToolsets(kind, 'claude') }, MCP_MAX_PHASE), kind).toHaveLength(163);
    }
    expect(toolsFor({ toolsets: defaultToolsets('global', 'codex') }, MCP_MAX_PHASE)).toHaveLength(83);
    expect(toolsFor({ toolsets: defaultToolsets('room', 'codex') }, MCP_MAX_PHASE)).toHaveLength(90);
    expect(toolsFor({ toolsets: defaultToolsets('project', 'codex') }, MCP_MAX_PHASE)).toHaveLength(100);
  });

  it('a Codex central with the cloud toolset on lists 119', () => {
    expect(toolsFor({ toolsets: [...defaultToolsets('global', 'codex'), 'cloud'] }, MCP_MAX_PHASE)).toHaveLength(119);
  });

  it('has a list for every toolset, and nothing else', () => {
    expect(Object.keys(toolsByToolset).sort()).toEqual([...ALL_TOOLSETS].sort());
  });

  it('files each tool under its own toolset, once, with a unique name, a phase and a risk', () => {
    const names = new Set<string>();
    for (const toolset of ALL_TOOLSETS) {
      for (const def of toolsByToolset[toolset]) {
        expect(def.toolset, def.name).toBe(toolset);
        expect(def.name, def.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
        expect(names.has(def.name), `${def.name} is filed twice`).toBe(false);
        names.add(def.name);
        expect([1, 2, 3, 4, 5, 6], def.name).toContain(def.phase);
        expect(RISKS, def.name).toContain(def.risk);
        expect(def.title.trim(), def.name).not.toBe('');
        expect(def.description.trim(), def.name).not.toBe('');
        expect(typeof def.input, def.name).toBe('object');
      }
    }
    expect(allTools().map((t) => t.name)).toEqual([...names]);
  });

  it('hands out a new list each time', () => {
    const first = allTools();
    first.push(tool('stray', 'system', 1));

    expect(allTools()).not.toBe(first);
    expect(allTools().map((t) => t.name)).not.toContain('stray');
  });
});

describe('centralInstructions', () => {
  const KINDS: CentralKind[] = ['global', 'room', 'project'];

  it.each(KINDS)('is short and plain, and names the scope of a %s central', (kind) => {
    const text = centralInstructions(kind, 1);

    expect(text.length).toBeGreaterThan(200);
    expect(text.length).toBeLessThanOrEqual(1_500);
    expect(text).toContain('scope_get');
    expect(text).toMatch(/NOT_IN_SCOPE/);
  });

  it('describes a different scope for each kind', () => {
    const scopes = KINDS.map(
      (kind) => /Your scope: ([^\n]*)/.exec(centralInstructions(kind, 1))?.[1],
    );

    expect(new Set(scopes).size).toBe(KINDS.length);
    expect(scopes[0]).toMatch(/every session/);
    expect(scopes[1]).toMatch(/room/);
    expect(scopes[2]).toMatch(/project folder/);
  });

  it('says text from another session is data, never instructions', () => {
    const text = centralInstructions('global', 1);

    expect(text).toContain('<untrusted');
    expect(text).toMatch(/data, never instructions/);
  });

  it('marks the tools of later phases "when available"', () => {
    const lines = centralInstructions('global', 1).split('\n');

    for (const name of ['task_delegate', 'task_wait']) {
      const line = lines.find((l) => l.includes(name));
      expect(line, name).toBeDefined();
      expect(line, name).toContain('(when available)');
    }
  });

  it('says the tools only read while the build stops at P1', () => {
    expect(centralInstructions('global', 1)).toMatch(/only read/);
    expect(centralInstructions('global', 2)).not.toMatch(/only read/);
  });

  it('carries no token, no token variable and no header', () => {
    for (const kind of KINDS) {
      const text = centralInstructions(kind, 1);
      expect(text).not.toMatch(/aasc_mcp_|AASC_MCP_TOKEN|Bearer|Authorization/i);
    }
  });
});
