/**
 * @module commandIndex
 * Enumerates available slash commands and skills across Claude / Codex / Gemini CLIs.
 *
 * Sources walked (per CLI):
 *   claude:
 *     - <project>/.claude/commands/*.md            (project commands)
 *     - <project>/.claude/skills/<slug>/SKILL.md   (project skills)
 *     - ~/.claude/commands/*.md                    (global commands)
 *     - ~/.claude/skills/<slug>/SKILL.md           (global skills)
 *     - <plugin>/commands/*.md                     (plugin commands)
 *     - <plugin>/skills/<slug>/SKILL.md            (plugin skills)
 *       plugins are discovered via ~/.claude/plugins/installed_plugins.json
 *   codex:
 *     - <project>/.codex/prompts/*.md              (project prompts)
 *     - ~/.codex/prompts/*.md                      (global prompts)
 *   gemini:
 *     - <project>/.gemini/commands/*.toml          (project commands)
 *     - ~/.gemini/commands/*.toml                  (global commands)
 *
 * Results are cached in-memory for 30 seconds keyed by `cli + projectPath`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import log from './logger.js';

export type CommandKind = 'command' | 'skill';
export type CommandSource = 'project' | 'global' | 'plugin' | 'builtin';

export interface CommandEntry {
  /** Bare name, e.g. "electron-build" (no leading slash). For plugin entries
   *  the user-facing slug is `<pluginName>:<name>` — built by clients. */
  name: string;
  description: string;
  cli: 'claude' | 'codex' | 'gemini';
  kind: CommandKind;
  source: CommandSource;
  sourcePath?: string;
  pluginName?: string;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { ts: number; entries: CommandEntry[] }>();

/** Strip YAML frontmatter and return (parsedFields, body). */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { fields: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { fields: {}, body: raw };
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      const val = m[2].trim();
      if (val === '>' || val === '|') {
        fields[currentKey] = '';
      } else {
        fields[currentKey] = val.replace(/^["']|["']$/g, '');
        currentKey = null;
      }
    } else if (currentKey && line.startsWith(' ')) {
      fields[currentKey] = (fields[currentKey] ? fields[currentKey] + ' ' : '') + line.trim();
    }
  }
  return { fields, body };
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t.replace(/[*_`]/g, '').slice(0, 200);
  }
  return '';
}

function readDescription(filePath: string): string {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const { fields, body } = parseFrontmatter(raw);
    return (fields.description || firstNonEmptyLine(body)).slice(0, 240);
  } catch {
    return '';
  }
}

function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function listTomlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.toml'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function listSkillDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => join(dir, d.name))
      .filter((p) => existsSync(join(p, 'SKILL.md')));
  } catch {
    return [];
  }
}

function makeCommandEntry(
  filePath: string,
  cli: CommandEntry['cli'],
  source: CommandSource,
  pluginName?: string,
): CommandEntry {
  const name = basename(filePath, filePath.endsWith('.toml') ? '.toml' : '.md');
  return {
    name,
    description: readDescription(filePath),
    cli,
    kind: 'command',
    source,
    sourcePath: filePath,
    pluginName,
  };
}

function makeSkillEntry(
  skillDir: string,
  cli: CommandEntry['cli'],
  source: CommandSource,
  pluginName?: string,
): CommandEntry {
  const skillFile = join(skillDir, 'SKILL.md');
  let name = basename(skillDir);
  let description = '';
  try {
    const raw = readFileSync(skillFile, 'utf8');
    const { fields } = parseFrontmatter(raw);
    if (fields.name) name = fields.name;
    if (fields.description) description = fields.description.slice(0, 240);
  } catch {
    /* fall through */
  }
  return { name, description, cli, kind: 'skill', source, sourcePath: skillFile, pluginName };
}

// ---------------------------------------------------------------------------
// Built-in command catalogs
// ---------------------------------------------------------------------------
//
// These commands live inside each CLI's own binary — they aren't discoverable
// from disk. Without an explicit catalog the autocomplete misses staples like
// `/clear`, `/compact`, `/help`. Source: each project's official docs.
// Update when upstream adds new slash commands.

interface BuiltinSpec {
  name: string;
  description: string;
}

const CLAUDE_BUILTINS: BuiltinSpec[] = [
  { name: 'add-dir', description: 'Add additional working directories to the session' },
  { name: 'agents', description: 'Manage custom AI subagents for specialized tasks' },
  { name: 'bashes', description: 'List and manage background bash shells' },
  { name: 'bug', description: 'Report bugs (sends conversation to Anthropic)' },
  { name: 'clear', description: 'Clear conversation history and free up context' },
  { name: 'compact', description: 'Compact conversation with optional focus instructions' },
  { name: 'config', description: 'View or modify configuration' },
  { name: 'context', description: 'Visualize current context usage' },
  { name: 'cost', description: 'Show token usage statistics' },
  { name: 'doctor', description: 'Diagnose and verify your Claude Code installation' },
  { name: 'export', description: 'Export the current conversation to a file or clipboard' },
  { name: 'fix-issue', description: 'Find and fix GitHub issues by number' },
  { name: 'help', description: 'Get usage help' },
  { name: 'hooks', description: 'Manage hook configurations for tool events' },
  { name: 'ide', description: 'Manage IDE integrations and show connection status' },
  { name: 'init', description: 'Initialize project with a CLAUDE.md guide' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Action for the repo' },
  { name: 'login', description: 'Switch Anthropic accounts' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'mcp', description: 'Manage MCP server connections and OAuth authentication' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'model', description: 'Select or change the AI model' },
  { name: 'output-style', description: 'Switch the output style' },
  { name: 'permissions', description: 'View or update tool permissions' },
  { name: 'plugin', description: 'Manage installed plugins' },
  { name: 'pr-comments', description: 'View pull request comments' },
  { name: 'release-notes', description: 'Show release notes for the current version' },
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'review', description: 'Request code review' },
  { name: 'security-review', description: 'Audit pending changes for security issues' },
  { name: 'status', description: 'Show version, model, account, connectivity and other info' },
  { name: 'todos', description: 'Show the current to-do list' },
  { name: 'update', description: 'Update to the latest Claude Code release' },
  { name: 'usage', description: 'Show plan usage limits and rate-limit status' },
  { name: 'vim', description: 'Enter vim editing mode' },
];

const CODEX_BUILTINS: BuiltinSpec[] = [
  { name: 'approvals', description: 'Change approval mode for tool calls' },
  { name: 'clear', description: 'Clear the session and start fresh' },
  { name: 'compact', description: 'Compact conversation history' },
  { name: 'diff', description: 'Show pending diff for the working directory' },
  { name: 'init', description: 'Initialize project with an AGENTS.md guide' },
  { name: 'logout', description: 'Sign out from your account' },
  { name: 'mcp', description: 'Manage MCP server connections' },
  { name: 'mention', description: 'Reference a file in the prompt' },
  { name: 'model', description: 'Select or change the AI model' },
  { name: 'new', description: 'Start a fresh session' },
  { name: 'quit', description: 'Exit Codex' },
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'status', description: 'Show version, account, and session info' },
  { name: 'undo', description: 'Undo the last assistant action' },
];

const GEMINI_BUILTINS: BuiltinSpec[] = [
  { name: 'auth', description: 'Manage authentication' },
  { name: 'bug', description: 'File a bug report' },
  { name: 'chat', description: 'Save, resume, list, or delete chat sessions' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compress', description: 'Compress context to free up tokens' },
  { name: 'copy', description: 'Copy the last response to clipboard' },
  { name: 'docs', description: 'Open the Gemini CLI documentation' },
  { name: 'editor', description: 'Pick an external editor for prompts' },
  { name: 'help', description: 'Show Gemini CLI help' },
  { name: 'init', description: 'Initialize a project guide' },
  { name: 'mcp', description: 'Manage MCP server connections' },
  { name: 'memory', description: 'Edit memory files' },
  { name: 'model', description: 'Select or change the AI model' },
  { name: 'privacy', description: 'View or change privacy settings' },
  { name: 'quit', description: 'Exit Gemini CLI' },
  { name: 'restore', description: 'Restore a previous session' },
  { name: 'settings', description: 'View or modify settings' },
  { name: 'stats', description: 'Show session token usage stats' },
  { name: 'theme', description: 'Change the CLI theme' },
  { name: 'tools', description: 'List available tools' },
  { name: 'vim', description: 'Enter vim editing mode' },
];

function appendBuiltins(
  entries: CommandEntry[],
  builtins: BuiltinSpec[],
  cli: CommandEntry['cli'],
): void {
  for (const b of builtins) {
    entries.push({
      name: b.name,
      description: b.description,
      cli,
      kind: 'command',
      source: 'builtin',
    });
  }
}

interface InstalledPluginsManifest {
  version?: number;
  plugins?: Record<string, Array<{ scope?: string; installPath?: string }>>;
}

function readInstalledPlugins(): Array<{ pluginName: string; installPath: string }> {
  const manifestPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as InstalledPluginsManifest;
    const out: Array<{ pluginName: string; installPath: string }> = [];
    const plugins = parsed.plugins || {};
    for (const [key, entries] of Object.entries(plugins)) {
      const pluginName = key.split('@')[0];
      for (const e of entries || []) {
        if (e.installPath && existsSync(e.installPath)) {
          out.push({ pluginName, installPath: e.installPath });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function isSafeProjectPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (p.length > 1024) return false;
  if (p.includes('\0')) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function buildClaudeEntries(projectPath: string | null): CommandEntry[] {
  const entries: CommandEntry[] = [];

  appendBuiltins(entries, CLAUDE_BUILTINS, 'claude');

  if (projectPath && isSafeProjectPath(projectPath)) {
    for (const f of listMdFiles(join(projectPath, '.claude', 'commands'))) {
      entries.push(makeCommandEntry(f, 'claude', 'project'));
    }
    for (const d of listSkillDirs(join(projectPath, '.claude', 'skills'))) {
      entries.push(makeSkillEntry(d, 'claude', 'project'));
    }
  }

  const home = homedir();
  for (const f of listMdFiles(join(home, '.claude', 'commands'))) {
    entries.push(makeCommandEntry(f, 'claude', 'global'));
  }
  for (const d of listSkillDirs(join(home, '.claude', 'skills'))) {
    entries.push(makeSkillEntry(d, 'claude', 'global'));
  }

  for (const { pluginName, installPath } of readInstalledPlugins()) {
    for (const f of listMdFiles(join(installPath, 'commands'))) {
      entries.push(makeCommandEntry(f, 'claude', 'plugin', pluginName));
    }
    for (const d of listSkillDirs(join(installPath, 'skills'))) {
      entries.push(makeSkillEntry(d, 'claude', 'plugin', pluginName));
    }
  }

  return entries;
}

function buildCodexEntries(projectPath: string | null): CommandEntry[] {
  const entries: CommandEntry[] = [];
  appendBuiltins(entries, CODEX_BUILTINS, 'codex');
  if (projectPath && isSafeProjectPath(projectPath)) {
    for (const f of listMdFiles(join(projectPath, '.codex', 'prompts'))) {
      entries.push(makeCommandEntry(f, 'codex', 'project'));
    }
  }
  for (const f of listMdFiles(join(homedir(), '.codex', 'prompts'))) {
    entries.push(makeCommandEntry(f, 'codex', 'global'));
  }
  return entries;
}

function buildGeminiEntries(projectPath: string | null): CommandEntry[] {
  const entries: CommandEntry[] = [];
  appendBuiltins(entries, GEMINI_BUILTINS, 'gemini');
  if (projectPath && isSafeProjectPath(projectPath)) {
    for (const f of listTomlFiles(join(projectPath, '.gemini', 'commands'))) {
      entries.push(makeCommandEntry(f, 'gemini', 'project'));
    }
  }
  for (const f of listTomlFiles(join(homedir(), '.gemini', 'commands'))) {
    entries.push(makeCommandEntry(f, 'gemini', 'global'));
  }
  return entries;
}

/**
 * Get the full command/skill index for a CLI + optional project root.
 * Cached for 30s per (cli, projectPath). Safe to call frequently.
 */
export function getCommandIndex(
  cli: 'claude' | 'codex' | 'gemini',
  projectPath: string | null,
): CommandEntry[] {
  const key = `${cli}|${projectPath || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return hit.entries;
  }
  let entries: CommandEntry[];
  try {
    if (cli === 'claude') entries = buildClaudeEntries(projectPath);
    else if (cli === 'codex') entries = buildCodexEntries(projectPath);
    else entries = buildGeminiEntries(projectPath);
  } catch (err) {
    log.error('commandIndex', `Failed for ${cli}: ${err instanceof Error ? err.message : String(err)}`);
    entries = [];
  }
  cache.set(key, { ts: Date.now(), entries });
  return entries;
}

/** Force-clear the cache (used by tests or when the user saves a new command). */
export function clearCommandIndexCache(): void {
  cache.clear();
}
