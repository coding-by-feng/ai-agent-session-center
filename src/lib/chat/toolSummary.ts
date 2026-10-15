/**
 * toolSummary.ts — a tool call in one line (AASC-41): "Read icons.tsx",
 * "Ran npm test", "Searched "MinimizeIcon" · 4 files", and a run of calls in one
 * phrase ("Read 3 files, ran 2 commands"). Claude's tool names and Codex's
 * (shell / exec_command argv, apply_patch, web_search…) map onto the same words.
 * Pure.
 */
import { basename, firstLine, formatCounts, plural } from './chatFormat';
import { editFiles, editTotals, isEditTool } from './editDiff';

export type ToolCategory = 'read' | 'edit' | 'command' | 'search' | 'fetch' | 'other';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const CATEGORY: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  view_image: 'read',
  read_file: 'read',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  KillBash: 'command',
  shell: 'command',
  exec_command: 'command',
  local_shell: 'command',
  unified_exec: 'command',
  write_stdin: 'command',
  exec: 'command',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  list_dir: 'search',
  grep_files: 'search',
  WebSearch: 'search',
  web_search: 'search',
  WebFetch: 'fetch',
  web_fetch: 'fetch',
};

export function toolCategory(name: string): ToolCategory {
  if (isEditTool(name)) return 'edit';
  return CATEGORY[name] ?? 'other';
}

export interface ToolDescription {
  /** "Read", "Ran", "Edited", "Searched"… */
  verb: string;
  /** What it acted on ("icons.tsx", "npm test", "“MinimizeIcon”"); may be ''. */
  target: string;
  /** Monospace target (a command, a path, a pattern). */
  mono: boolean;
  /** A short fact after it ("4 files", "+1 −1"). */
  meta: string;
  /** The whole command a shell call ran, for the expanded row. */
  command: string | null;
  /** The file a read or edit touched, whole. */
  path: string | null;
}

const SHELLS = new Set(['bash', 'zsh', 'sh', '/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh']);

/** A command from an argv (`["bash", "-lc", "npm test"]` → "npm test"). */
export function argvCommand(argv: unknown[]): string {
  const words = argv.filter((a): a is string => typeof a === 'string');
  if (words.length >= 3 && SHELLS.has(words[0]) && (words[1] === '-lc' || words[1] === '-c')) return words[2];
  return words.map((w) => (/[\s"'$]/.test(w) ? JSON.stringify(w) : w)).join(' ');
}

/** The command a shell-like tool ran, or null. */
export function shellCommand(name: string, input: unknown): string | null {
  if (typeof input === 'string') return name === 'exec' ? null : input || null;
  if (!isRec(input)) return null;
  if (typeof input.command === 'string') return input.command;
  if (Array.isArray(input.command)) return argvCommand(input.command);
  if (typeof input.cmd === 'string') return input.cmd;
  if (Array.isArray(input.cmd)) return argvCommand(input.cmd);
  return null;
}

/** "Found 4 files" → "4 files"; a Glob's list → "N files". */
function searchMeta(name: string, output: string | undefined): string {
  if (!output) return '';
  const found = /^\s*Found (\d+) (files?|lines?|matches?|occurrences?)/i.exec(output);
  if (found) return `${found[1]} ${found[2].toLowerCase()}`;
  if (name === 'Glob') {
    if (/^\s*No files found/i.test(output)) return 'no files';
    const n = output.split('\n').filter((l) => l.trim()).length;
    return n > 0 ? plural(n, 'file') : '';
  }
  return '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** `mcp__github__create_issue` → "github: create issue". */
function mcpName(name: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2].replace(/_/g, ' ')}` : null;
}

const quote = (text: string): string => (text ? `“${text}”` : '');

function describe(verb: string, target = '', extra: Partial<ToolDescription> = {}): ToolDescription {
  return { verb, target, mono: false, meta: '', command: null, path: null, ...extra };
}

export function describeTool(name: string, input: unknown, output?: string): ToolDescription {
  const rec = isRec(input) ? input : {};
  const path = str(rec.file_path) || str(rec.notebook_path) || str(rec.path);

  if (isEditTool(name)) {
    const files = editFiles(name, input);
    const counts = formatCounts(editTotals(files));
    const only = files.length === 1 ? files[0] : null;
    const verb = only?.created ? 'Created' : only?.deleted ? 'Deleted' : name === 'Write' ? 'Wrote' : 'Edited';
    const target = only ? basename(only.path) : files.length > 1 ? plural(files.length, 'file') : basename(path);
    return describe(verb, target, { meta: counts, mono: !!only, path: only?.path ?? (path || null) });
  }

  const command = shellCommand(name, name === 'local_shell' && isRec(rec.action) ? rec.action : input);
  switch (toolCategory(name)) {
    case 'command':
      if (name === 'BashOutput') return describe('Checked a background command');
      if (name === 'KillShell' || name === 'KillBash') return describe('Stopped a background command');
      if (name === 'write_stdin') return describe('Typed into a running command');
      if (name === 'exec' && !command) return describe('Ran a script');
      return describe('Ran', firstLine(command ?? ''), { mono: true, command });
    case 'read':
      return describe(name === 'view_image' ? 'Viewed' : 'Read', basename(path), { mono: true, path: path || null });
    case 'search': {
      if (name === 'WebSearch' || name === 'web_search') return describe('Searched the web', quote(str(rec.query)));
      if (name === 'LS' || name === 'list_dir') return describe('Listed', basename(path) || 'a folder', { mono: true });
      if (name === 'Glob') return describe('Found files', str(rec.pattern), { mono: true, meta: searchMeta(name, output) });
      if (name === 'ToolSearch') return describe('Looked up tools', quote(str(rec.query)));
      const pattern = str(rec.pattern) || str(rec.query);
      return describe('Searched', quote(pattern), { meta: searchMeta(name, output) });
    }
    case 'fetch':
      return describe('Fetched', hostOf(str(rec.url)));
    default:
      break;
  }
  if (name === 'Skill') return describe('Used skill', str(rec.skill) || str(rec.command));
  if (name === 'ExitPlanMode') return describe('Proposed a plan');
  if (name === 'AskUserQuestion') return describe('Asked you a question');
  if (name === 'SlashCommand') return describe('Ran', str(rec.command), { mono: true });
  const mcp = mcpName(name);
  if (mcp) return describe('Used', mcp);
  return describe('Used', name);
}

const PHRASE: Record<ToolCategory, (n: number) => string> = {
  read: (n) => `read ${plural(n, 'file')}`,
  edit: (n) => `edited ${plural(n, 'file')}`,
  command: (n) => `ran ${plural(n, 'command')}`,
  search: (n) => (n === 1 ? 'searched once' : `searched ${n} times`),
  fetch: (n) => `fetched ${plural(n, 'page')}`,
  other: (n) => `used ${plural(n, 'tool')}`,
};

/** "Read 3 files, ran 2 commands" — categories in the order they first appear. */
export function groupSummary(categories: readonly ToolCategory[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const text = [...counts].map(([c, n]) => PHRASE[c](n)).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
