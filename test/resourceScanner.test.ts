// test/resourceScanner.test.ts — one full read-only scan over a fixture HOME.
//
// The fixture holds a little of everything the RESOURCES tab must understand —
// Claude + Codex + ~/.agents globals, one project with nested instructions, a
// fake agent-skills repo — plus the traps: plugin caches holding stale skills,
// credential files, secrets inside config values, a symlinked skill, a broken
// one, and memory left behind by a deleted project. Every assertion is made on
// the catalog a client would receive (plus every detail it could request), so
// "the secret never appears" is checked on the real output, not on internals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { scanResources } from '../server/resourceScanner.js';
import type { ScanOutput } from '../server/resourceScanner.js';
import { createResourceCatalog } from '../server/resourceCatalog.js';
import { encodeProjectPath } from '../server/resourceRoots.js';
import { sha256Text, stableStringify } from '../server/fsSafe.js';
import type {
  ResourceCatalog, ResourceDetail, ResourceSummary, ResourceType, ScanProgress,
} from '../src/types/resources.js';

// Symlinks need elevated rights on Windows, so fixtures create them only where
// they can exist and the tests that depend on one skip elsewhere — a platform
// that cannot express the fixture is not a failure of the code under test.
const NO_SYMLINKS = process.platform === 'win32';
const link = (target: string, path: string, type?: 'dir'): void => {
  if (!NO_SYMLINKS) symlinkSync(target, path, type);
};
// chmod 000 stops neither root nor Windows from reading — tests that need a
// locked file or folder skip there.
const CANNOT_LOCK = process.platform === 'win32' || process.getuid?.() === 0;

const SECRETS = [
  'CLAUDE-SECRET-TOKEN-XYZ', // ~/.claude/secrets/token.txt
  'CRED-SECRET-ABC', // ~/.claude/.credentials.json
  'CODEX-AUTH-SECRET-456', // ~/.codex/auth.json
  'ENV-SECRET-VALUE-123', // settings.json env
  '7.25e+300', // a NUMBER under env — numbers are shown unless a deny rule masks them
  'URLSECRET999', // MCP url query
  'HEADERSECRET777', // MCP header
  'MCPENVSECRET', // .mcp.json env
  'CODEXMCPENV', // config.toml mcp env
  'me@example.com', // ~/.claude.json oauthAccount
  'PKG-ENV-SECRET', // a .env inside a skill package
  'A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5', // token passed in MCP args
  'PEM-SECRET-BODY', // a credential-named file sitting in hooks/
];

let base = '';
let home = '';
let project = '';
let out: ScanOutput;
let catalog: ResourceCatalog;
let details: ResourceDetail[] = [];
let compares: unknown[] = [];
const progress: ScanProgress[] = [];

function put(rel: string, content: string | Buffer): string {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

const fm = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n`;

function buildFixture(): void {
  const C = '.claude';
  const X = '.codex';
  // --- Claude global skills -------------------------------------------------
  put(`${C}/skills/alpha/SKILL.md`, `${fm('alpha', 'Alpha skill')}\nRun ${home}/bin/tool.\n`);
  put(`${C}/skills/alpha/scripts/run.sh`, 'echo run\n');
  put(`${C}/skills/alpha/.env`, 'TOKEN=PKG-ENV-SECRET\n');
  put(`${C}/skills/beta/SKILL.md`, '# Beta without frontmatter\n');
  put(`${C}/skills/gamma/SKILL.md`, '---\nname: [unclosed\n---\nbody\n');
  // Invalid YAML (an unquoted ": " in a plain scalar) that Claude Code itself reads fine.
  put(`${C}/skills/colon-desc/SKILL.md`, '---\nname: colon-desc\ndescription: Use when: the user asks\n---\nbody\n');
  put(`${C}/skills/delta/SKILL.md`, `${fm('not-delta', 'Delta')}body\n`);
  put(`${C}/skills/todo/SKILL.md`, `${fm('todo', 'Todo')}same everywhere\n`);
  put(`${C}/skills/todo/.git/HEAD`, 'ref: refs/heads/main\n');
  put(`${C}/skills/review/SKILL.md`, `${fm('review', 'Review')}claude flavour\n`);
  put(`${C}/skills/notaskill/README.md`, 'no SKILL.md here');
  put(`${C}/skills/_shared/diagrams/style.md`, 'shared');
  mkdirSync(join(home, C, 'skills', 'learned'), { recursive: true });
  for (let i = 0; i < 6; i++) put(`${C}/skills/big/f${i}.md`, `file ${i}`);
  put(`${C}/skills/big/SKILL.md`, `${fm('big', 'Big')}body`);
  put('Documents/kason-tools/skills/linked-skill/SKILL.md', `${fm('linked-skill', 'Linked')}body`);
  link(join(home, 'Documents/kason-tools/skills/linked-skill'), join(home, C, 'skills', 'linked-skill'), 'dir');
  link(join(home, 'nowhere'), join(home, C, 'skills', 'broken-skill'), 'dir');
  put(`${C}/skills/synced/sync-1/manifest.json`, JSON.stringify({ skills: [{ name: 'pdf', description: 'From manifest' }] }));
  put(`${C}/skills/synced/sync-1/pdf/SKILL.md`, '---\nname: pdf\n---\nbody');
  // --- Claude global: commands, rules, instructions, agents, hooks ----------
  put(`${C}/commands/bilingual-md.md`, 'Write EN + CN\n');
  put(`${C}/commands/ns/deploy.md`, '---\ndescription: Deploy it\n---\nsteps\n');
  put(`${C}/rules/coding-style.md`, '# Style\n');
  put(`${C}/rules/common/coding-style.md`, '# Common style\n');
  put(`${C}/CLAUDE.md`, '# Global Claude\n');
  put(`${C}/agents/reviewer.md`, `${fm('reviewer', 'Reviews code')}body`);
  put(`${C}/hooks/dashboard-hook.sh`, '#!/bin/sh\necho hook\n');
  put(`${C}/hooks/save.py`, 'print("save")\n');
  put(`${C}/settings.json`, JSON.stringify({
    model: 'opus',
    env: { SECRET_ENV: 'ENV-SECRET-VALUE-123', CACHE_SIZE: 7.25e300 },
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    },
  }));
  put(`${C}/settings.local.json`, JSON.stringify({ permissions: { allow: ['Read'] } }));
  // --- Claude plugins: only the CURRENT installPath may be walked -----------
  const installPath = join(home, C, 'plugins/cache/market/demo/1.0.0');
  put(`${C}/plugins/installed_plugins.json`, JSON.stringify({
    version: 2,
    plugins: { 'demo@market': [{ scope: 'user', installPath, version: '1.0.0' }] },
  }));
  put(`${C}/plugins/cache/market/demo/1.0.0/skills/plugskill/SKILL.md`, `${fm('plugskill', 'Plugin skill')}body`);
  put(`${C}/plugins/cache/market/demo/1.0.0/commands/plugcmd.md`, 'plugin command');
  put(`${C}/plugins/cache/market/demo/1.0.0/agents/plugagent.md`, 'plugin agent');
  put(`${C}/plugins/cache/market/demo/0.9.0/skills/stale-version/SKILL.md`, `${fm('stale-version', 'x')}`);
  put(`${C}/plugins/cache/other/skills/cacheonly/SKILL.md`, `${fm('cacheonly', 'x')}`);
  put(`${C}/plugins/marketplaces/market/skills/mkt-skill/SKILL.md`, `${fm('mkt-skill', 'x')}`);
  // --- Claude memory, transcripts, history, credentials ---------------------
  const enc = encodeProjectPath(project);
  put(`${C}/projects/${enc}/memory/MEMORY.md`, '- [Note](note.md)\n');
  put(`${C}/projects/${enc}/memory/note.md`, `${fm('note', 'A project note')}body`);
  put(`${C}/projects/${enc}/abc.jsonl`, 'x'.repeat(100));
  put(`${C}/projects/${encodeProjectPath(join(home, 'work', 'gone-project'))}/memory/old.md`, 'orphaned');
  put(`${C}/history.jsonl`, 'y'.repeat(50));
  put(`${C}/secrets/token.txt`, 'CLAUDE-SECRET-TOKEN-XYZ');
  put(`${C}/.credentials.json`, JSON.stringify({ token: 'CRED-SECRET-ABC' }));
  put('.claude.json', JSON.stringify({
    oauthAccount: { emailAddress: 'me@example.com' },
    mcpServers: {
      github: {
        type: 'http',
        url: 'https://api.example.com/mcp?token=URLSECRET999',
        headers: { Authorization: 'Bearer HEADERSECRET777' },
      },
    },
    projects: { [project]: { mcpServers: { projmcp: { command: 'node', args: ['srv.js'] } } } },
  }));
  // --- Codex global ----------------------------------------------------------
  put(`${X}/skills/todo/SKILL.md`, `${fm('todo', 'Todo')}same everywhere\n`);
  put(`${X}/skills/review/SKILL.md`, `${fm('review', 'Review')}codex flavour\n`);
  put(`${X}/skills/.system/imagegen/SKILL.md`, `${fm('imagegen', 'Images')}body`);
  put(`${X}/skills/_shared/x.md`, 'shared');
  put(`${X}/prompts/bilingual-md.md`, 'Write EN + CN\n');
  put(`${X}/rules/default.rules`, 'prefix_rule(pattern=["ls"], decision="allow")\n');
  put(`${X}/AGENTS.md`, '');
  put(`${X}/hooks/dashboard-hook.sh`, '#!/bin/sh\necho codex hook\n');
  put(`${X}/config.toml`, [
    'model = "gpt-5"',
    'approval_policy = "on-request"',
    `[projects."${project}"]`,
    'trust_level = "trusted"',
    '[mcp_servers.kason]',
    'url = "https://mcp.example.com/"',
    '[mcp_servers.kason.env]',
    'KEY = "CODEXMCPENV"',
    '[plugins."github@openai"]',
    'enabled = true',
    '[[hooks.PreToolUse]]',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "echo codex"',
    '[hooks.state."x:pre_tool_use:0:0"]',
    'trusted_hash = "abc"',
    '',
  ].join('\n'));
  put(`${X}/keybindings.json`, '{}');
  put(`${X}/memories/MEMORY.md`, '# Codex memory\n');
  put(`${X}/memories/.git/notes.md`, 'git internals');
  put(`${X}/sessions/2026/01/01/rollout.jsonl`, 'z'.repeat(30));
  put(`${X}/archived_sessions/old.jsonl`, 'z'.repeat(20));
  put(`${X}/history.jsonl`, 'h'.repeat(10));
  put(`${X}/state_5.sqlite`, Buffer.alloc(64));
  put(`${X}/auth.json`, JSON.stringify({ tokens: { access_token: 'CODEX-AUTH-SECRET-456' } }));
  put(`${X}/plugins/cache/x/skills/codexcache/SKILL.md`, `${fm('codexcache', 'x')}`);
  put(`${X}/.tmp/skills/tmpskill/SKILL.md`, `${fm('tmpskill', 'x')}`);
  put(`${X}/vendor_imports/skills/vend/SKILL.md`, `${fm('vend', 'x')}`);
  // --- ~/.agents -------------------------------------------------------------
  put('.agents/skills/shared-one/SKILL.md', `${fm('shared-one', 'Shared skill')}body`);
  // --- One project -----------------------------------------------------------
  const P = 'work/proj';
  put(`${P}/.claude/skills/alpha/SKILL.md`, `${fm('alpha', 'Project alpha')}body`);
  put(`${P}/.claude/commands/build.md`, 'claude build');
  put(`${P}/.claude/rules/proj-rule.md`, '# rule');
  put(`${P}/.claude/agents/helper.md`, 'helper');
  put(`${P}/.claude/settings.json`, '{ "model": "opus", }');
  put(`${P}/.claude/hooks/check.sh`, 'echo check');
  put(`${P}/CLAUDE.md`, '# Project Claude\n');
  put(`${P}/AGENTS.md`, '# Project Agents (different)\n');
  put(`${P}/.mcp.json`, JSON.stringify({
    mcpServers: {
      local: {
        command: 'npx',
        args: ['-y', 'x', '--token', `ghp_${'A1b2C3d4E5'.repeat(4)}`],
        env: { K: 'MCPENVSECRET' },
      },
    },
  }));
  put(`${P}/.codex/skills/pskill/SKILL.md`, `${fm('pskill', 'P skill')}body`);
  put(`${P}/.codex/prompts/build.md`, 'codex build');
  put(`${P}/.codex/config.toml`, '[mcp_servers.pm]\ncommand = "pm-server"\n');
  put(`${P}/.agents/skills/pshared/SKILL.md`, `${fm('pshared', 'P shared')}body`);
  put(`${P}/packages/api/CLAUDE.md`, '# API\n');
  put(`${P}/packages/api/.claude/skills/nested-skill/SKILL.md`, `${fm('nested-skill', 'Nested')}body`);
  put(`${P}/node_modules/pkg/CLAUDE.md`, 'vendored');
  put(`${P}/a/b/c/d/CLAUDE.md`, 'too deep');
  put(`${P}/.claude/worktrees/wt/CLAUDE.md`, 'worktree copy');
  // --- Traps: a resource path that is really a credential, and unreadable files ---
  put(`${C}/skills/sneaky/README.md`, 'the SKILL.md here is a link to a credential');
  link(join(home, X, 'auth.json'), join(home, C, 'skills', 'sneaky', 'SKILL.md'));
  link(join(home, C, 'secrets', 'token.txt'), join(home, C, 'commands', 'leak.md'));
  put(`${C}/hooks/deploy.pem`, 'PEM-SECRET-BODY');
  put(`${C}/skills/locked-skill/SKILL.md`, `${fm('locked-skill', 'Locked')}body`);
  chmodSync(put(`${C}/skills/locked-skill/locked.md`, 'no read permission'), 0o000);
  chmodSync(put(`${C}/rules/locked-rule.md`, '# unreadable'), 0o000);
  // --- The agent-skills repo -------------------------------------------------
  const R = 'Documents/agent-skills';
  put(`${R}/claude/skills/sneaky/SKILL.md`, 'repo copy of sneaky');
  put(`${R}/claude/skills/todo/SKILL.md`, `${fm('todo', 'Todo')}same everywhere\n`);
  put(`${R}/claude/skills/alpha/SKILL.md`, `${fm('alpha', 'Alpha skill (older)')}body\n`);
  put(`${R}/claude/skills/repo-only-skill/SKILL.md`, `${fm('repo-only-skill', 'x')}`);
  put(`${R}/claude/commands/bilingual-md.md`, 'Write EN + CN\n');
  put(`${R}/claude/rules/coding-style.md`, '# Style\n');
  put(`${R}/claude/hooks/dashboard-hook.sh`, '#!/bin/sh\necho hook\n');
  put(`${R}/codex/skills/todo/SKILL.md`, `${fm('todo', 'Todo')}same everywhere\n`);
  put(`${R}/codex/prompts/bilingual-md.md`, 'Write EN + CN\n');
  put(`${R}/codex/rules/default.rules`, 'prefix_rule(pattern=["ls"], decision="allow")\n');
  put(`${R}/codex/AGENTS.md`, '');
}

const find = (pred: (r: ResourceSummary) => boolean) => catalog.resources.filter(pred);
const one = (type: ResourceType, name: string, extra: Partial<ResourceSummary> = {}): ResourceSummary => {
  const hits = find((r) => r.type === type && r.name === name
    && Object.entries(extra).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
  expect(hits, `${type} ${name} ${JSON.stringify(extra)}`).toHaveLength(1);
  return hits[0];
};
const findingsFor = (id: string) => catalog.findings.filter((f) => f.resourceId === id).map((f) => f.code);
const projectId = () => catalog.projects.find((p) => p.name === 'proj')?.id;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-scan-')));
  home = join(base, 'home');
  project = join(home, 'work', 'proj');
  mkdirSync(project, { recursive: true });
  buildFixture();

  const opts = {
    env: {},
    home,
    sessionProjectPaths: [project],
    extraRoots: [],
    limits: { packageMaxFiles: 5 },
  };
  out = await scanResources({ ...opts, onProgress: (p) => progress.push(p) });
  catalog = {
    state: 'ready',
    roots: out.roots,
    projects: out.projects,
    resources: out.resources,
    findings: out.findings,
    coverage: out.coverage,
  };

  const svc = createResourceCatalog({ env: {}, home, sessionProjectPaths: () => [project], limits: { packageMaxFiles: 5 } });
  svc.startScan();
  await svc.whenIdle();
  details = (await Promise.all(svc.getCatalog().resources.map((r) => svc.getDetail(r.id))))
    .filter((d): d is ResourceDetail => d !== null);
  compares = await Promise.all(svc.getCatalog().resources.flatMap((r) =>
    ['repo', ...r.variantIds].map((against) => svc.getCompare(r.id, against))));
}, 30_000);

afterAll(() => {
  chmodSync(join(home, '.claude', 'skills', 'locked-skill', 'locked.md'), 0o644);
  chmodSync(join(home, '.claude', 'rules', 'locked-rule.md'), 0o644);
  rmSync(base, { recursive: true, force: true });
});

describe('scanResources — every type, agent, scope, origin, format', () => {
  it('lists global Claude resources', () => {
    expect(one('skill', 'alpha', { scope: 'global' })).toMatchObject({
      agent: 'claude', origin: 'user', format: 'markdown', description: 'Alpha skill', path: '~/.claude/skills/alpha',
    });
    expect(one('command', 'ns:deploy')).toMatchObject({ agent: 'claude', scope: 'global', description: 'Deploy it' });
    expect(one('rule', 'common/coding-style.md')).toMatchObject({ agent: 'claude', format: 'markdown' });
    expect(one('instructions', 'CLAUDE.md', { scope: 'global' })).toMatchObject({ agent: 'claude' });
    expect(one('agent', 'reviewer')).toMatchObject({ agent: 'claude', scope: 'global' });
    expect(one('hook', 'PreToolUse', { agent: 'claude' })).toMatchObject({ format: 'config', path: '~/.claude/settings.json' });
    expect(one('hook', 'dashboard-hook.sh', { agent: 'claude' })).toMatchObject({ format: 'script' });
    expect(one('mcp', 'github')).toMatchObject({ agent: 'claude', scope: 'global', format: 'config', path: '~/.claude.json' });
    expect(one('plugin', 'demo@market')).toMatchObject({ agent: 'claude', format: 'config' });
    expect(one('settings', 'settings.json', { agent: 'claude', scope: 'global' }).format).toBe('config');
    expect(one('settings', '.claude.json')).toMatchObject({ agent: 'claude', scope: 'global' });
  });

  it('lists global Codex resources — prompts as commands, .rules as policy', () => {
    expect(one('skill', 'todo', { agent: 'codex' }).origin).toBe('user');
    expect(one('command', 'bilingual-md', { agent: 'codex' })).toMatchObject({ path: '~/.codex/prompts/bilingual-md.md' });
    expect(one('rule', 'default.rules')).toMatchObject({ agent: 'codex', format: 'policy' });
    expect(one('instructions', 'AGENTS.md', { scope: 'global' })).toMatchObject({ agent: 'codex' });
    expect(one('hook', 'PreToolUse', { agent: 'codex' }).format).toBe('config');
    expect(find((r) => r.type === 'hook' && r.name === 'state')).toHaveLength(0);
    expect(one('mcp', 'kason')).toMatchObject({ agent: 'codex', scope: 'global' });
    expect(one('plugin', 'github@openai')).toMatchObject({ agent: 'codex' });
    expect(one('settings', 'config.toml', { scope: 'global' }).agent).toBe('codex');
    expect(one('settings', 'keybindings.json').agent).toBe('codex');
    expect(one('memory', 'MEMORY.md', { agent: 'codex' }).scope).toBe('global');
    expect(find((r) => r.agent === 'codex' && r.type === 'memory' && r.name.includes('.git'))).toHaveLength(0);
  });

  it('lists ~/.agents skills as agent "shared"', () => {
    expect(one('skill', 'shared-one')).toMatchObject({ agent: 'shared', scope: 'global' });
  });

  it('lists project resources with the project id', () => {
    const pid = projectId();
    expect(pid).toBeTruthy();
    const inProject = (r: ResourceSummary) => r.scope === 'project' && r.projectId === pid;
    expect(one('skill', 'alpha', { scope: 'project' }).projectId).toBe(pid);
    for (const [type, name, agent] of [
      ['command', 'build', 'claude'], ['command', 'build', 'codex'], ['rule', 'proj-rule.md', 'claude'],
      ['agent', 'helper', 'claude'], ['hook', 'check.sh', 'claude'], ['mcp', 'local', 'claude'],
      ['mcp', 'projmcp', 'claude'], ['mcp', 'pm', 'codex'], ['skill', 'pskill', 'codex'], ['skill', 'pshared', 'shared'],
      ['skill', 'nested-skill', 'claude'], ['instructions', 'packages/api/CLAUDE.md', 'claude'],
    ] as const) {
      const hits = find((r) => r.type === type && r.name === name && r.agent === agent && inProject(r));
      expect(hits, `${agent} ${type} ${name}`).toHaveLength(1);
    }
    expect(one('skill', 'pshared').agent).toBe('shared');
    expect(one('memory', 'note.md')).toMatchObject({ scope: 'project', projectId: pid, description: 'A project note' });
    expect(catalog.projects.find((p) => p.id === pid)?.counts).toMatchObject({ skill: 4, memory: 2 });
  });

  it('bounds the nested walk: depth 3, skip list, .claude/worktrees', () => {
    const names = find((r) => r.type === 'instructions' && r.projectId === projectId()).map((r) => r.name).sort();
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md', 'packages/api/CLAUDE.md']);
  });
});

describe('scanResources — origins', () => {
  it('tags plugin items and never walks plugin caches or marketplaces', () => {
    for (const [type, name] of [['skill', 'plugskill'], ['command', 'plugcmd'], ['agent', 'plugagent']] as const) {
      expect(one(type, name)).toMatchObject({ origin: 'plugin', pluginName: 'demo', agent: 'claude' });
    }
    const all = catalog.resources.map((r) => r.name);
    for (const hidden of ['stale-version', 'cacheonly', 'mkt-skill', 'codexcache', 'tmpskill', 'vend']) {
      expect(all).not.toContain(hidden);
    }
  });

  it('tags Codex .system skills as system and synced skills as synced', () => {
    expect(one('skill', 'imagegen')).toMatchObject({ origin: 'system', agent: 'codex' });
    expect(one('skill', 'pdf')).toMatchObject({ origin: 'synced', description: 'From manifest' });
  });

  it('includes _shared as a (not-a-)skill and skips dirs without SKILL.md', () => {
    expect(one('skill', '_shared', { agent: 'claude' }).description).toBe('Shared files used by other skills (not a skill)');
    expect(find((r) => r.name === 'notaskill' || r.name === 'learned')).toHaveLength(0);
  });

  it.skipIf(NO_SYMLINKS)('follows a symlinked skill: linked, linkTarget, linked-outside', () => {
    const s = one('skill', 'linked-skill');
    expect(s).toMatchObject({ origin: 'linked', linkTarget: '~/Documents/kason-tools/skills/linked-skill' });
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(findingsFor(s.id)).toContain('linked-outside');
    expect(s.repo.status).toBe('not-in-repo');
  });

  it.skipIf(NO_SYMLINKS)('reports a broken symlink without a hash', () => {
    const s = one('skill', 'broken-skill');
    expect(s.hash).toBeUndefined();
    expect(findingsFor(s.id)).toContain('broken-symlink');
  });
});

describe('scanResources — content checks', () => {
  it('parses frontmatter and flags missing / invalid / mismatched names', () => {
    expect(findingsFor(one('skill', 'beta').id)).toContain('frontmatter-missing');
    expect(findingsFor(one('skill', 'gamma').id)).toContain('frontmatter-invalid');
    expect(findingsFor(one('skill', 'delta').id)).toContain('name-mismatch');
    expect(findingsFor(one('skill', 'todo', { agent: 'claude' }).id)).not.toContain('frontmatter-missing');
  });

  it('still shows the description of a skill whose frontmatter is not strict YAML', () => {
    const s = one('skill', 'colon-desc');
    expect(findingsFor(s.id)).toContain('frontmatter-invalid');
    expect(s.description).toBe('Use when: the user asks');
  });

  it('flags a hardcoded home path and a package over the hash cap', () => {
    expect(findingsFor(one('skill', 'alpha', { scope: 'global' }).id)).toContain('hardcoded-home-path');
    const big = one('skill', 'big');
    expect(big.hash).toBeUndefined();
    expect(findingsFor(big.id)).toContain('hash-capped');
  });

  it('skips .git inside a skill when listing and hashing', () => {
    const todo = one('skill', 'todo', { agent: 'claude' });
    expect(todo.fileCount).toBe(1);
    const d = details.find((x) => x.summary.id === todo.id);
    expect(d?.files?.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('reports a config file that does not parse, and keeps scanning', () => {
    const s = one('settings', 'settings.json', { scope: 'project' });
    const f = catalog.findings.find((x) => x.resourceId === s.id && x.code === 'config-parse-error');
    expect(f).toMatchObject({ severity: 'error' });
    const cov = catalog.coverage.find((c) => c.root === '~/work/proj' && c.agent === 'claude' && c.category === 'settings');
    expect(cov?.status).toBe('failed');
  });
});

describe('scanResources — variants and duplicates', () => {
  it('pairs Claude and Codex copies of a skill, and flags only the ones that differ', () => {
    const cTodo = one('skill', 'todo', { agent: 'claude' });
    const xTodo = one('skill', 'todo', { agent: 'codex' });
    expect(cTodo.variantIds).toEqual([xTodo.id]);
    expect(xTodo.variantIds).toEqual([cTodo.id]);
    expect(findingsFor(cTodo.id)).not.toContain('variant-differs');
    const cReview = one('skill', 'review', { agent: 'claude' });
    expect(findingsFor(cReview.id)).toContain('variant-differs');
    expect(findingsFor(one('skill', 'review', { agent: 'codex' }).id)).toContain('variant-differs');
  });

  it('pairs a Claude command with the Codex prompt of the same name, per scope', () => {
    const c = one('command', 'bilingual-md', { agent: 'claude' });
    expect(c.variantIds).toEqual([one('command', 'bilingual-md', { agent: 'codex' }).id]);
    expect(one('command', 'build', { agent: 'claude' }).variantIds).toEqual([one('command', 'build', { agent: 'codex' }).id]);
  });

  it('pairs CLAUDE.md with AGENTS.md in the same root', () => {
    const pc = one('instructions', 'CLAUDE.md', { scope: 'project' });
    const pa = one('instructions', 'AGENTS.md', { scope: 'project' });
    expect(pc.variantIds).toEqual([pa.id]);
    expect(findingsFor(pc.id)).toContain('variant-differs');
    expect(one('instructions', 'CLAUDE.md', { scope: 'global' }).variantIds)
      .toEqual([one('instructions', 'AGENTS.md', { scope: 'global' }).id]);
  });

  it('never pairs rules', () => {
    expect(find((r) => r.type === 'rule').every((r) => r.variantIds.length === 0)).toBe(true);
  });

  it('flags a project skill that shadows a global one', () => {
    expect(findingsFor(one('skill', 'alpha', { scope: 'project' }).id)).toContain('duplicate-name');
    expect(findingsFor(one('skill', 'alpha', { scope: 'global' }).id)).toContain('duplicate-name');
    expect(findingsFor(one('skill', 'todo', { agent: 'claude' }).id)).not.toContain('duplicate-name');
  });
});

describe('scanResources — repo compare', () => {
  it('reports same / differs / not-in-repo / not-tracked', () => {
    expect(one('skill', 'todo', { agent: 'claude' }).repo).toEqual({
      status: 'same', path: '~/Documents/agent-skills/claude/skills/todo',
    });
    const alpha = one('skill', 'alpha', { scope: 'global' });
    expect(alpha.repo.status).toBe('differs');
    expect(findingsFor(alpha.id)).toContain('repo-differs');
    const beta = one('skill', 'beta');
    expect(beta.repo.status).toBe('not-in-repo');
    expect(findingsFor(beta.id)).toContain('not-in-repo');
    expect(one('instructions', 'CLAUDE.md', { scope: 'global' }).repo.status).toBe('not-tracked');
    expect(one('memory', 'note.md').repo.status).toBe('not-tracked');
    expect(one('skill', 'alpha', { scope: 'project' }).repo.status).toBe('not-tracked');
    expect(one('skill', 'imagegen').repo.status).toBe('not-tracked');
  });

  it('compares every tracked mapping (commands, rules, hooks, prompts, policy, AGENTS.md)', () => {
    expect(one('command', 'bilingual-md', { agent: 'claude' }).repo.status).toBe('same');
    expect(one('rule', 'coding-style.md').repo.status).toBe('same');
    expect(one('hook', 'dashboard-hook.sh', { agent: 'claude' }).repo.status).toBe('same');
    expect(one('hook', 'save.py').repo.status).toBe('not-in-repo');
    expect(one('skill', 'todo', { agent: 'codex' }).repo.status).toBe('same');
    expect(one('command', 'bilingual-md', { agent: 'codex' }).repo.status).toBe('same');
    expect(one('rule', 'default.rules').repo.status).toBe('same');
    expect(one('instructions', 'AGENTS.md', { scope: 'global' }).repo.status).toBe('same');
    expect(one('hook', 'dashboard-hook.sh', { agent: 'codex' }).repo.status).toBe('not-tracked');
  });

  it('reports repo items with no live counterpart as repo-only, by path', () => {
    const f = catalog.findings.filter((x) => x.code === 'repo-only');
    // Without symlinks the live `sneaky` folder has no SKILL.md, so its repo copy is unclaimed too.
    const unclaimed = ['repo-only-skill', ...(NO_SYMLINKS ? ['sneaky'] : [])];
    expect(f.map((x) => x.path)).toEqual(unclaimed.map((n) => `~/Documents/agent-skills/claude/skills/${n}`));
    expect(f[0].resourceId).toBeUndefined();
  });
});

describe('scanResources — memory, coverage, secrets', () => {
  it('keeps memory of a deleted project as orphaned', () => {
    const old = one('memory', 'old.md');
    expect(old.orphaned).toBe(true);
    expect(findingsFor(old.id)).toContain('orphaned-memory');
    expect(catalog.projects.find((p) => p.id === old.projectId)?.exists).toBe(false);
  });

  it('sizes sessions and history without reading them, and excludes credentials', () => {
    const cov = (agent: string, category: string) =>
      catalog.coverage.find((c) => c.agent === agent && c.category === category && c.root.startsWith(`~/.${agent}`));
    expect(cov('claude', 'sessions')).toMatchObject({ status: 'not-scanned', count: 1, bytes: 100 });
    expect(cov('claude', 'history')).toMatchObject({ status: 'not-scanned', bytes: 50 });
    expect(cov('claude', 'credentials')).toMatchObject({ status: 'excluded', count: 2, note: 'names only, never read' });
    expect(cov('codex', 'sessions')).toMatchObject({ status: 'not-scanned', count: 2, bytes: 50 });
    expect(cov('codex', 'databases')).toMatchObject({ status: 'not-scanned', bytes: 64 });
    expect(cov('codex', 'credentials')).toMatchObject({ status: 'excluded', count: 1 });
    expect(cov('codex', 'plugin-contents')).toMatchObject({ status: 'not-scanned', note: 'record only' });
    expect(cov('claude', 'skill')).toMatchObject({ status: 'scanned' });
  });

  it('never lets a credential or a masked config value into the catalog, any detail, or any compare', () => {
    const everything = JSON.stringify(catalog) + JSON.stringify(details) + JSON.stringify(compares);
    expect(details.length).toBe(catalog.resources.length);
    expect(compares.filter(Boolean).length).toBeGreaterThan(5);
    for (const secret of SECRETS) expect(everything, secret).not.toContain(secret);
  });

  it('lists a resource that resolves to a credential by name only — no body, no content hash', () => {
    const linked = NO_SYMLINKS ? [] : [['skill', 'sneaky'], ['command', 'leak']] as const;
    for (const [type, name] of [...linked, ['hook', 'deploy.pem']] as const) {
      const r = one(type, name);
      expect(details.find((d) => d.summary.id === r.id)?.body, name).toBeUndefined();
      // A package still hashes its in-package link by TARGET STRING (never the target's bytes).
      if (type !== 'skill') expect(r.hash, name).toBeUndefined();
    }
  });

  it.skipIf(CANNOT_LOCK)('keeps scanning past files it may not read', () => {
    expect(one('rule', 'locked-rule.md').hash).toBeUndefined();
    const locked = one('skill', 'locked-skill');
    expect(locked.fileCount).toBe(2);
  });

  it('carries display paths only — the absolute home path never appears', () => {
    expect(JSON.stringify(catalog)).not.toContain(home);
    // A body is the file's own text (alpha's SKILL.md really does hardcode the
    // home path — that is the finding); everything the server derives is display-only.
    const derived = details.map(({ body: _body, ...rest }) => rest);
    expect(JSON.stringify(derived)).not.toContain(home);
    expect(catalog.roots).toEqual({
      claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: '~/Documents/agent-skills',
    });
  });

  it('keeps ids stable across scans and reports progress through to done', async () => {
    const again = await scanResources({ env: {}, home, sessionProjectPaths: [project], extraRoots: [], limits: { packageMaxFiles: 5 } });
    expect(again.resources.map((r) => r.id).sort()).toEqual(catalog.resources.map((r) => r.id).sort());
    expect(new Set(catalog.resources.map((r) => r.id)).size).toBe(catalog.resources.length);
    expect(progress.at(-1)?.phase).toBe('done');
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['roots', 'resources', 'hashing', 'repo', 'checks']));
  });
});

describe('scanResources — config hashes are keyed (security review L9)', () => {
  it('never publishes the plain sha256 of a config file or a config entry', () => {
    const settings = one('settings', 'settings.json', { agent: 'claude', scope: 'global' });
    expect(settings.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(settings.hash).not.toBe(sha256Text(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')));
    const hook = one('hook', 'PreToolUse', { agent: 'claude' });
    expect(hook.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hook.hash).not.toBe(sha256Text(stableStringify([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }])));
  });

  it('keeps them stable across scans within one process', async () => {
    const again = await scanResources({ env: {}, home, sessionProjectPaths: [project], extraRoots: [], limits: { packageMaxFiles: 5 } });
    const configs = catalog.resources.filter((r) => r.format === 'config');
    expect(configs.length).toBeGreaterThan(5);
    for (const r of configs) expect(again.resources.find((x) => x.id === r.id)?.hash, r.name).toBe(r.hash);
  });
});

/** A fresh temp HOME + a scanned catalog service, for cases the shared fixture must not absorb. */
async function scanFixture(prefix: string, files: Record<string, string>, projectRel?: string, setup?: (h: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const h = join(root, 'home');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(h, rel)), { recursive: true });
    writeFileSync(join(h, rel), content);
  }
  setup?.(h);
  const svc = createResourceCatalog({ env: {}, home: h, sessionProjectPaths: () => (projectRel ? [join(h, projectRel)] : []) });
  svc.startScan();
  await svc.whenIdle();
  const find = (type: ResourceType, name: string) => svc.getCatalog().resources.find((r) => r.type === type && r.name === name);
  return { root, home: h, svc, find };
}

describe('credential checks are judged relative to the scanned root (review item A)', () => {
  let fx: Awaited<ReturnType<typeof scanFixture>>;
  beforeAll(async () => {
    fx = await scanFixture('aasc-scan-secrets-', {
      'Documents/Secrets/proj/CLAUDE.md': '# Under a Secrets folder\n',
      'Documents/Secrets/proj/.claude/settings.json': JSON.stringify({ model: 'opus' }),
      'Documents/Secrets/proj/.claude/commands/deploy.md': 'deploy steps\n',
      'Documents/Secrets/proj/.claude/commands/secrets/leak.md': 'IN-PROJECT-SECRET-DIR\n',
    }, 'Documents/Secrets/proj');
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it('keeps the body, hash and settings fields of a project that sits under a folder named Secrets', async () => {
    const md = fx.find('instructions', 'CLAUDE.md');
    expect(md?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await fx.svc.getDetail(md?.id ?? ''))?.body).toBe('# Under a Secrets folder\n');
    expect((await fx.svc.getDetail(fx.find('command', 'deploy')?.id ?? ''))?.body).toBe('deploy steps\n');
    const settings = await fx.svc.getDetail(fx.find('settings', 'settings.json')?.id ?? '');
    expect(settings?.fields).toContainEqual({ key: 'model', value: 'opus', masked: false, kind: 'string' });
  });

  it('still treats a secrets/ folder INSIDE the root as credentials', async () => {
    const leak = fx.find('command', 'secrets:leak');
    expect(leak).toBeDefined();
    expect(leak?.hash).toBeUndefined();
    expect(JSON.stringify(await fx.svc.getDetail(leak?.id ?? ''))).not.toContain('IN-PROJECT-SECRET-DIR');
  });
});

describe.skipIf(NO_SYMLINKS)('single files are confined to their root (security review M3)', () => {
  let fx: Awaited<ReturnType<typeof scanFixture>>;
  const id = (type: ResourceType, name: string, agent = 'claude') =>
    fx.svc.getCatalog().resources.find((r) => r.type === type && r.name === name && r.agent === agent)?.id ?? '';
  beforeAll(async () => {
    fx = await scanFixture('aasc-scan-confine-', {
      'elsewhere/notes.md': '---\ndescription: OUTSIDE-DESCRIPTION\n---\nOUTSIDE-BODY-TEXT\n',
      '.aws/credentials': '[default]\naws_secret_access_key = AWS-SECRET-VALUE\n',
      '.codex/prompts/outside.md': 'codex copy\n',
      'Documents/agent-skills/claude/commands/outside.md': 'repo copy\n',
      '.claude/commands/swap.md': 'SWAP-ORIGINAL\n',
      '.claude/skills/pkg/SKILL.md': '---\nname: pkg\ndescription: P\n---\nbody\n',
      'elsewhere/pkg2/SKILL.md': '---\nname: pkg\ndescription: P2\n---\nOTHER-PACKAGE\n',
    }, undefined, (h) => {
      symlinkSync(join(h, 'elsewhere', 'notes.md'), join(h, '.claude', 'commands', 'outside.md'));
      symlinkSync(join(h, '.aws', 'credentials'), join(h, '.claude', 'commands', 'aws.md'));
    });
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it('keeps the row, hash and linked-outside finding of a file linked outside, but serves no content', async () => {
    const r = fx.find('command', 'outside');
    expect(r).toMatchObject({ origin: 'linked', linkTarget: '~/elsewhere/notes.md' });
    expect(r?.hash).toMatch(/^[0-9a-f]{64}$/);
    const detail = await fx.svc.getDetail(r?.id ?? '');
    expect(detail?.body).toBeUndefined();
    expect(detail?.findings.find((f) => f.code === 'linked-outside')?.message).toMatch(/not shown/);
    const everything = JSON.stringify(fx.svc.getCatalog()) + JSON.stringify(detail);
    expect(everything).not.toContain('OUTSIDE-BODY-TEXT');
    expect(everything).not.toContain('OUTSIDE-DESCRIPTION');
  });

  it('refuses to compare it (403) — against the repo copy and against a variant, from either side', async () => {
    const claude = id('command', 'outside');
    const codex = id('command', 'outside', 'codex');
    expect(fx.find('command', 'outside')?.variantIds).toEqual([codex]);
    for (const [left, against] of [[claude, 'repo'], [claude, codex], [codex, claude]]) {
      await expect(fx.svc.getCompare(left, against), `${left} vs ${against}`).rejects.toMatchObject({ status: 403 });
    }
  });

  it('never hashes or reads a link to a credential outside the root', async () => {
    const r = fx.find('command', 'aws');
    expect(r?.hash).toBeUndefined();
    expect(JSON.stringify(await fx.svc.getDetail(r?.id ?? ''))).not.toContain('AWS-SECRET-VALUE');
  });

  it('refuses (409) a file or package that resolves somewhere else than at scan time', async () => {
    const swap = id('command', 'swap');
    expect((await fx.svc.getDetail(swap))?.body).toBe('SWAP-ORIGINAL\n');
    rmSync(join(fx.home, '.claude', 'commands', 'swap.md'));
    symlinkSync(join(fx.home, 'elsewhere', 'notes.md'), join(fx.home, '.claude', 'commands', 'swap.md'));
    await expect(fx.svc.getDetail(swap)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed since the last scan/i) });

    const pkg = id('skill', 'pkg');
    renameSync(join(fx.home, '.claude', 'skills', 'pkg'), join(fx.home, 'pkg-moved'));
    symlinkSync(join(fx.home, 'elsewhere', 'pkg2'), join(fx.home, '.claude', 'skills', 'pkg'), 'dir');
    await expect(fx.svc.getDetail(pkg)).rejects.toMatchObject({ status: 409 });
    await expect(fx.svc.getFile(pkg, 'SKILL.md')).rejects.toMatchObject({ status: 409 });
  });
});

describe.skipIf(CANNOT_LOCK)('a project that cannot be read is inaccessible, not missing (review item B)', () => {
  let fx: Awaited<ReturnType<typeof scanFixture>>;
  beforeAll(async () => {
    fx = await scanFixture('aasc-scan-locked-', { 'Locked/proj/CLAUDE.md': '# locked\n' }, 'Locked/proj', (h) => {
      const memory = join(h, '.claude', 'projects', encodeProjectPath(join(h, 'Locked', 'proj')), 'memory');
      mkdirSync(memory, { recursive: true });
      writeFileSync(join(memory, 'note.md'), 'a note\n');
      chmodSync(join(h, 'Locked'), 0o000);
    });
  });
  afterAll(() => {
    chmodSync(join(fx.home, 'Locked'), 0o755);
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('is not reported missing, its memory is not orphaned, and its coverage reads inaccessible', () => {
    const c = fx.svc.getCatalog();
    expect(c.projects.find((p) => p.name === 'proj')).toMatchObject({ exists: true });
    const note = fx.find('memory', 'note.md');
    expect(note?.orphaned).toBeUndefined();
    expect(c.findings.filter((f) => f.code === 'orphaned-memory')).toEqual([]);
    const rows = c.coverage.filter((r) => r.root === '~/Locked/proj');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'inaccessible')).toBe(true);
  });
});

describe('scan queue (review item C)', () => {
  it('keeps a queued scan when a later join repeats the in-flight roots', async () => {
    const svc = createResourceCatalog({ env: {}, home, sessionProjectPaths: () => [project], limits: { packageMaxFiles: 5 } });
    const added = join(base, 'queued', 'extra-c');
    svc.startScan([]); // in flight
    svc.startScan([added]); // queued: a folder added mid-scan
    svc.startScan([]); // same roots as the scan in flight — must not drop the queued one
    await svc.whenIdle();
    expect(svc.getCatalog().projects.find((p) => p.name === 'extra-c')).toMatchObject({ exists: false, evidence: ['added'] });
  });
});

describe.skipIf(NO_SYMLINKS)('linked folders are reported, not silently skipped (review item D)', () => {
  let fx: Awaited<ReturnType<typeof scanFixture>>;
  beforeAll(async () => {
    fx = await scanFixture('aasc-scan-linked-dirs-', {
      '.claude/commands/a.md': 'a\n',
      '.claude/rules/.keep': '',
      'work/proj/.claude/agents/helper.md': 'helper\n',
      'elsewhere/cmds/b.md': 'b\n',
      'elsewhere/more/c.md': 'c\n',
      'elsewhere/rules/r.md': 'r\n',
    }, 'work/proj', (h) => {
      symlinkSync(join(h, 'elsewhere', 'cmds'), join(h, '.claude', 'commands', 'linked'), 'dir');
      symlinkSync(join(h, 'elsewhere', 'more'), join(h, '.claude', 'commands', 'more'), 'dir');
      symlinkSync(join(h, 'elsewhere', 'rules'), join(h, '.claude', 'rules', 'shared'), 'dir');
      symlinkSync(join(h, 'elsewhere', 'more'), join(h, 'work', 'proj', '.claude', 'agents', 'team'), 'dir');
    });
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it('notes them on the coverage row — global and project', () => {
    const row = (root: string, category: string) =>
      fx.svc.getCatalog().coverage.find((c) => c.root === root && c.agent === 'claude' && c.category === category);
    expect(row('~/.claude', 'command')).toMatchObject({ status: 'scanned', count: 1, note: '2 linked folders not followed' });
    expect(row('~/.claude', 'rule')).toMatchObject({ status: 'empty', note: '1 linked folder not followed' });
    expect(row('~/work/proj', 'agent')).toMatchObject({ status: 'scanned', count: 1, note: '1 linked folder not followed' });
    expect(fx.find('command', 'linked:b')).toBeUndefined();
  });
});
