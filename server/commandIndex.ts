/**
 * @module commandIndex
 * Enumerates available slash commands and skills across Claude / Codex CLIs.
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
 *     - <project>/.codex/prompts/*.md              (project prompts, /name)
 *     - <project>/.codex/skills/<slug>/SKILL.md    (project skills, $name)
 *     - $CODEX_HOME/prompts/*.md                   (global prompts, /name)
 *     - $CODEX_HOME/skills/<slug>/SKILL.md         (global skills, $name)
 *     - $CODEX_HOME/skills/.system/<slug>/SKILL.md (preinstalled skills, $name)
 *       CODEX_HOME defaults to ~/.codex. Codex addresses skills as `$name`,
 *       NOT `/name` — see `src/lib/autocompleteTrigger.ts`.
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
  cli: 'claude' | 'codex';
  kind: CommandKind;
  source: CommandSource;
  sourcePath?: string;
  pluginName?: string;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { ts: number; entries: CommandEntry[] }>();

/** A YAML block-scalar header: `>` (folded) or `|` (literal), optionally with
 *  a chomping indicator (`-` strip, `+` keep) and/or an indentation indicator
 *  (1-9), in either order — `>`, `>-`, `|+`, `>2-`, `|-2`. Only the bare `>`
 *  and `|` used to count, so `description: >-` (a common way to write a long
 *  skill description) came through as the literal text ">-" and the folded
 *  lines under it were dropped — the `/` dropdown then printed ">-". A
 *  trailing `# comment` after the header is legal YAML and allowed too. */
const BLOCK_SCALAR_HEADER = /^[>|](?:[+-]?[1-9]?|[1-9][+-])(?:\s+#.*)?$/;

/** Strip YAML frontmatter and return (parsedFields, body). */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { fields: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { fields: {}, body: raw };
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  // Strip a trailing \r from every line: a SKILL.md saved with CRLF endings
  // otherwise matched no `key: value` line at all (`.` stops before \r, so
  // `(.*)$` fails) and lost its whole frontmatter, name included.
  for (const line of fmRaw.split('\n').map((l) => l.replace(/\r$/, ''))) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      const val = m[2].trim();
      if (BLOCK_SCALAR_HEADER.test(val)) {
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

/** True for a real directory OR a symlink pointing at one. */
function isDirLike(p: string): boolean {
  try {
    // statSync follows symlinks; Dirent.isDirectory() does NOT — it reports
    // false for a symlinked skill dir, which silently hides skills that were
    // linked in from another repo (a common way to share them across CLIs).
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Skill dirs directly under `dir`. Names starting with `_` or `.` are skipped —
 * they hold shared resources (`_shared/`) or a nested tier (`.system/`) rather
 * than a skill. To reach such a tier, pass its path in as `dir`; the filter
 * only ever inspects the child names.
 */
function listSkillDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => join(dir, d.name))
      .filter((p) => isDirLike(p) && existsSync(join(p, 'SKILL.md')));
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
// `/clear`, `/compact`, `/help`. Source: each CLI's own `/` list, walked in tmux
// (Claude Code v2.1.300, Codex v0.162.1, Oct 2026). Claude's renamed commands
// keep their old names as aliases (`/cost` → `/usage`, `/bashes` → `/tasks`,
// `/review` → `/code-review`); only the current name is listed. Skills that come
// from a claude.ai account (docx, pdf, …) are left out: not every user has them.
// Update when upstream adds new slash commands.

interface BuiltinSpec {
  name: string;
  description: string;
}

const CLAUDE_BUILTINS: BuiltinSpec[] = [
  { name: 'add-dir', description: 'Add additional working directories to the session' },
  { name: 'advisor', description: 'Let Claude consult a stronger model at key moments' },
  { name: 'artifacts', description: 'Browse your published and shared artifacts' },
  { name: 'auto-mode-setup', description: 'Teach auto mode about your environment, plus optional rule tweaks' },
  { name: 'autocompact', description: 'Set how full the context gets before auto-summarizing' },
  { name: 'autofix-pr', description: 'Monitor and autofix any issues with the current PR' },
  { name: 'background', description: 'Send this session to the background and free the terminal' },
  { name: 'batch', description: 'Plan a large change, then run it in parallel across isolated worktree agents' },
  { name: 'branch', description: 'Create a branch of the current conversation at this point' },
  { name: 'btw', description: 'Ask a quick side question without interrupting the main conversation' },
  { name: 'bug', description: 'Report bugs (sends conversation to Anthropic)' },
  { name: 'cd', description: 'Move this session to a new working directory' },
  { name: 'chrome', description: 'Open Claude in Chrome settings' },
  { name: 'claude-api', description: 'Reference for the Claude API / Anthropic SDK' },
  { name: 'clear', description: 'Clear conversation history and free up context' },
  { name: 'color', description: 'Set the prompt bar color for this session' },
  { name: 'code-review', description: 'Review the current changes for bugs (alias /review)' },
  { name: 'compact', description: 'Compact conversation with optional focus instructions' },
  { name: 'config', description: 'View or modify configuration' },
  { name: 'context', description: 'Visualize current context usage' },
  { name: 'copy', description: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)" },
  { name: 'debug', description: 'Enable debug logging for this session and help diagnose issues' },
  { name: 'desktop', description: 'Continue the current session in Claude Desktop' },
  { name: 'diff', description: 'Toggle the diff panel showing uncommitted changes' },
  { name: 'doctor', description: 'Diagnose and verify your Claude Code installation' },
  { name: 'effort', description: 'Set effort level for model usage' },
  { name: 'exit', description: 'Exit the CLI' },
  { name: 'export', description: 'Export the current conversation to a file or clipboard' },
  { name: 'fast', description: 'Toggle fast mode' },
  { name: 'feedback', description: 'Send feedback to Anthropic or report a bug' },
  { name: 'fewer-permission-prompts', description: 'Add an allowlist for common read-only tool calls from your transcripts' },
  { name: 'focus', description: 'Toggle focus view: just your prompt, summary, and response' },
  { name: 'fork', description: 'Copy this conversation into a new background session and keep working here' },
  { name: 'goal', description: 'Set a goal Claude checks before stopping' },
  { name: 'help', description: 'Get usage help' },
  { name: 'hooks', description: 'Manage hook configurations for tool events' },
  { name: 'ide', description: 'Manage IDE integrations and show connection status' },
  { name: 'import', description: 'Import config from another AI coding agent' },
  { name: 'init', description: 'Initialize project with a CLAUDE.md guide' },
  { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Action for the repo' },
  { name: 'install-slack-app', description: 'Install the Claude Slack app' },
  { name: 'keybindings', description: 'Open your keyboard shortcuts file' },
  { name: 'list-agents', description: 'List subagents, teammates, and other Claude sessions you can message' },
  { name: 'login', description: 'Switch Anthropic accounts' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'loop', description: 'Run a prompt or slash command on a recurring interval' },
  { name: 'mcp', description: 'Manage MCP server connections and OAuth authentication' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'mobile', description: 'Show QR code to download the Claude mobile app' },
  { name: 'model', description: 'Select or change the AI model' },
  { name: 'output-style', description: 'Switch the output style' },
  { name: 'passes', description: 'Share a free week of Claude Code with friends and earn usage credits' },
  { name: 'permissions', description: 'View or update tool permissions' },
  { name: 'plugin', description: 'Manage installed plugins' },
  { name: 'powerup', description: 'Discover Claude Code features through quick interactive lessons' },
  { name: 'privacy-settings', description: 'View and update your privacy settings' },
  { name: 'radio', description: 'Listen to Claude FM lo-fi radio' },
  { name: 'rate-limit-options', description: 'Manage usage limits and upgrade options' },
  { name: 'recap', description: 'Generate a one-line session recap now' },
  { name: 'release-notes', description: 'Show release notes for the current version' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes in the current session' },
  { name: 'reload-skills', description: 'Pick up skills added or changed on disk during this session' },
  { name: 'remote-control', description: 'Connect or disconnect Remote Control' },
  { name: 'remote-env', description: 'Choose the default environment for cloud agents' },
  { name: 'rename', description: 'Rename the current conversation' },
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'rewind', description: 'Restore the code and/or conversation to a previous point' },
  { name: 'sandbox', description: 'Configure the sandbox' },
  { name: 'schedule', description: 'Create, update, list, or run scheduled cloud agents (routines)' },
  { name: 'security-review', description: 'Audit pending changes for security issues' },
  { name: 'simplify', description: 'Review changed code for reuse, simplification and efficiency, then fix it' },
  { name: 'skill-doctor', description: 'Show which loaded skills are unused and costing context' },
  { name: 'skills', description: 'List available skills' },
  { name: 'status', description: 'Show version, model, account, connectivity and other info' },
  { name: 'statusline', description: "Set up Claude Code's status line UI" },
  { name: 'stickers', description: 'Order Claude Code stickers' },
  { name: 'subtask', description: 'Send a subagent off with your full context; its result comes back here' },
  { name: 'tasks', description: 'View and manage everything running in the background' },
  { name: 'team-onboarding', description: 'Help teammates ramp on Claude Code with a guide from your usage' },
  { name: 'teleport', description: 'Send this session to the cloud, or resume one from claude.ai' },
  { name: 'terminal-setup', description: 'Install Shift+Enter key binding for newlines' },
  { name: 'theme', description: 'Change the theme' },
  { name: 'tui', description: 'Set the terminal UI renderer (default | fullscreen)' },
  { name: 'ultrareview', description: 'Start a cloud agent that finds and verifies bugs in your branch' },
  { name: 'update-config', description: 'Configure the Claude Code harness via settings.json' },
  { name: 'upgrade', description: 'Upgrade your plan for higher rate limits' },
  { name: 'usage', description: 'Show session cost, plan usage limits and rate-limit status' },
  { name: 'usage-credits', description: 'Configure usage credits or request them from your admin' },
  { name: 'voice', description: 'Toggle voice mode' },
  { name: 'web-setup', description: 'Set up cloud sessions with your GitHub account' },
  { name: 'workflows', description: 'Browse running and completed workflows' },
];

const CODEX_BUILTINS: BuiltinSpec[] = [
  { name: 'agents', description: 'Open the agent command center' },
  { name: 'app', description: 'Continue this session in the Desktop app' },
  { name: 'approve', description: 'Approve one retry of a recent auto-review denial' },
  { name: 'archive', description: 'Archive this session' },
  { name: 'cd', description: 'Change the current working directory' },
  { name: 'clear', description: 'Clear the terminal and start a new chat' },
  { name: 'compact', description: 'Summarize conversation to prevent hitting the context limit' },
  { name: 'copy', description: 'Copy the last response or part of it' },
  { name: 'daemon', description: 'Manage the local background server' },
  { name: 'delete', description: 'Permanently delete this session' },
  { name: 'diff', description: 'Show git diff (including untracked files)' },
  { name: 'exit', description: 'Exit Codex' },
  { name: 'experimental', description: 'Toggle experimental features' },
  { name: 'export', description: 'Export the conversation as markdown' },
  { name: 'fast', description: '2x speed, increased usage' },
  { name: 'feedback', description: 'Send logs to maintainers' },
  { name: 'fork', description: 'Fork the current chat' },
  { name: 'goal', description: 'Set or view the goal for a long-running task' },
  { name: 'hooks', description: 'View and manage lifecycle hooks' },
  { name: 'ide', description: 'Include current selection, open files and other context from your IDE' },
  { name: 'import', description: 'Import setup, this project, and recent chats from Claude Code' },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for Codex' },
  { name: 'keymap', description: 'Remap TUI shortcuts' },
  { name: 'logout', description: 'Log out of Codex' },
  { name: 'mcp', description: 'List MCP tools; /mcp verbose or /mcp login <name>' },
  { name: 'memories', description: 'Configure memory use and generation' },
  { name: 'mention', description: 'Mention a file' },
  { name: 'model', description: 'Choose what model and reasoning effort to use' },
  { name: 'new', description: 'Start a new chat during a conversation' },
  { name: 'permissions', description: 'Choose what Codex is allowed to do' },
  { name: 'pets', description: 'Choose or hide the terminal pet' },
  { name: 'plan', description: 'Switch to Plan mode' },
  { name: 'plugins', description: 'Browse plugins' },
  { name: 'ps', description: 'List background terminals' },
  { name: 'pwd', description: 'Show the current working directory' },
  { name: 'raw', description: 'Toggle raw scrollback mode for copy-friendly selection' },
  { name: 'recap', description: 'Summarize the current conversation now' },
  { name: 'rename', description: 'Rename the current thread' },
  { name: 'resume', description: 'Resume a saved chat' },
  { name: 'review', description: 'Review my current changes and find issues' },
  { name: 'side', description: 'Start a side conversation in an ephemeral fork' },
  { name: 'skills', description: 'Use skills to improve how Codex performs specific tasks' },
  { name: 'status', description: 'Show current session configuration and token usage' },
  { name: 'statusline', description: 'Configure which items appear in the status line' },
  { name: 'stop', description: 'Stop all background terminals' },
  { name: 'subagents', description: "Switch between this session's subagents" },
  { name: 'theme', description: 'Choose a syntax highlighting theme' },
  { name: 'title', description: 'Configure which items appear in the terminal title' },
  { name: 'tui', description: 'Choose the TUI mode for the next launch' },
  { name: 'usage', description: 'View account usage or use a usage limit reset' },
  { name: 'vim', description: 'Toggle Vim mode for the composer' },
  { name: 'voice', description: 'Start or stop voice; /voice settings to choose a voice' },
  { name: 'warnings', description: 'View retained warnings and diagnostic details' },
  { name: 'worktree', description: 'Start or continue a conversation in a new worktree' },
];

/** Every built-in command name of either CLI, lowercased (for callers that must tell a command from a folder name). */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  [...CLAUDE_BUILTINS, ...CODEX_BUILTINS].map((b) => b.name.toLowerCase()),
);

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

/**
 * Codex's config root. `CODEX_HOME` overrides it — Codex's own docs spell every
 * skill path as `$CODEX_HOME/skills` with `~/.codex` only as the fallback, so
 * hardcoding homedir() would miss skills entirely on an overridden setup.
 * Read per call, not at module load, so an env change doesn't need a restart.
 */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function buildCodexEntries(projectPath: string | null): CommandEntry[] {
  const entries: CommandEntry[] = [];
  appendBuiltins(entries, CODEX_BUILTINS, 'codex');

  if (projectPath && isSafeProjectPath(projectPath)) {
    for (const f of listMdFiles(join(projectPath, '.codex', 'prompts'))) {
      entries.push(makeCommandEntry(f, 'codex', 'project'));
    }
    for (const d of listSkillDirs(join(projectPath, '.codex', 'skills'))) {
      entries.push(makeSkillEntry(d, 'codex', 'project'));
    }
  }

  const home = codexHome();
  for (const f of listMdFiles(join(home, 'prompts'))) {
    entries.push(makeCommandEntry(f, 'codex', 'global'));
  }

  const skillsRoot = join(home, 'skills');
  for (const d of listSkillDirs(skillsRoot)) {
    entries.push(makeSkillEntry(d, 'codex', 'global'));
  }
  // `.system/` holds the skills Codex preinstalls ($imagegen, $skill-creator,
  // $skill-installer, …). They are as invocable as any other, but the dot
  // prefix hides the whole tier from the ordinary walk — group them under
  // "built-in" so they read as shipped-with-Codex rather than user-authored.
  for (const d of listSkillDirs(join(skillsRoot, '.system'))) {
    entries.push(makeSkillEntry(d, 'codex', 'builtin'));
  }

  return entries;
}

/**
 * Get the full command/skill index for a CLI + optional project root.
 * Cached for 30s per (cli, projectPath). Safe to call frequently.
 */
export function getCommandIndex(
  cli: 'claude' | 'codex',
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
    else entries = buildCodexEntries(projectPath);
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
