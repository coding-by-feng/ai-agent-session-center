// config.ts — Extracted session status & approval detection configuration
import { config as serverConfig } from './serverConfig.js';
import type { ToolCategory } from '../src/types/settings.js';

// ---- Tool Categories for Approval Detection ----
// When PreToolUse fires, we start a timer. If PostToolUse doesn't arrive
// within the timeout, the tool is likely pending user interaction.
// NOTE: PermissionRequest event (when available at medium+ density) provides
// a direct signal for approval-needed state, replacing the timeout heuristic.

export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
  // Tools that complete instantly when auto-approved (3s timeout)
  fast: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit'],
  // Tools that ALWAYS require user interaction — not approval, but input (3s timeout)
  userInput: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
  // Tools that can be slow but not minutes-slow (15s timeout)
  medium: ['WebFetch', 'WebSearch'],
  // Tools that can run for minutes but still need approval detection (8s timeout).
  // Tradeoff: auto-approved long-running commands (npm install, builds) will
  // briefly show as "approval" after 8s until PostToolUse clears it.
  slow: ['Bash', 'Task'],
};

export const TOOL_TIMEOUTS: Record<ToolCategory, number> = {
  fast: 3000,
  userInput: 3000,
  medium: 15000,
  slow: 8000,
};

// Status to set when each category's timeout fires
export const WAITING_REASONS: Record<ToolCategory, string> = {
  fast: 'approval',     // "NEEDS YOUR APPROVAL"
  userInput: 'input',   // "WAITING FOR YOUR ANSWER"
  medium: 'approval',   // "NEEDS YOUR APPROVAL"
  slow: 'approval',     // "NEEDS YOUR APPROVAL"
};

// Human-readable labels for waitingDetail per category
export const WAITING_LABELS: Record<string, (toolName: string, detail: string) => string> = {
  approval: (toolName: string, detail: string) =>
    detail ? `Approve ${toolName}: ${detail}` : `Approve ${toolName}`,
  input: (toolName: string, _detail: string) => {
    if (toolName === 'AskUserQuestion') return 'Waiting for your answer';
    if (toolName === 'EnterPlanMode') return 'Review plan mode request';
    if (toolName === 'ExitPlanMode') return 'Review plan';
    return `Waiting for input on ${toolName}`;
  },
};

// ---- Auto-Idle Timeouts ----
// Sessions transition to idle/waiting if no activity for these durations (ms)
export const AUTO_IDLE_TIMEOUTS: Record<string, number> = {
  prompting: 30_000,    // prompting -> waiting (user likely cancelled)
  waiting: 300_000,     // waiting -> idle (5 min)
  // working -> idle is a pure SAFETY NET for a crashed/abandoned tool whose
  // Stop/PostToolUse hook was lost. A genuinely busy agent can think (or run a
  // single long tool) for minutes WITHOUT emitting any hook event — in the
  // Electron app the server never sees the streaming terminal output — so a
  // short timeout here mislabels a running session as green "Idle". Keep the
  // transition (the chain gate depends on decayed-idle NOT counting as a Stop
  // signal) but make it patient: 15 min covers real long turns.
  working: 900_000,     // working -> idle (15 min safety net)
  approval: 600_000,    // approval -> idle (10 min safety net)
  input: 600_000,       // input -> idle (10 min safety net)
};

// ---- Process Liveness Check ----
// How often to check if session PIDs are still alive (ms).
// When a user closes VS Code, JetBrains, or terminal abruptly, the SessionEnd
// hook never fires. This monitor detects dead processes and auto-ends sessions.
export const PROCESS_CHECK_INTERVAL: number = serverConfig.processCheckInterval || 15_000;

// ---- Animation State Mappings ----
export const STATUS_ANIMATIONS: Record<string, { animationState: string; emote: string | null }> = {
  idle:      { animationState: 'Idle',    emote: null },
  prompting: { animationState: 'Walking', emote: 'Wave' },
  working:   { animationState: 'Running', emote: null },
  approval:  { animationState: 'Waiting', emote: null },
  input:     { animationState: 'Waiting', emote: null },
  waiting:   { animationState: 'Waiting', emote: 'ThumbsUp' },
  ended:     { animationState: 'Death',   emote: null },
};

// ---- Precomputed Tool -> Category Lookup ----
// Built once at import time for O(1) lookups in hot path
const _toolToCategory = new Map<string, ToolCategory>();
for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
  for (const tool of tools) {
    _toolToCategory.set(tool, category as ToolCategory);
  }
}

/**
 * Get the category for a tool name.
 * @returns 'fast' | 'userInput' | 'medium' | 'slow' | null (no timeout)
 */
export function getToolCategory(toolName: string): ToolCategory | null {
  return _toolToCategory.get(toolName) || null;
}

/**
 * Get the approval/input timeout for a tool, or 0 if no detection applies.
 */
export function getToolTimeout(toolName: string): number {
  const cat = getToolCategory(toolName);
  return cat ? (TOOL_TIMEOUTS[cat] || 0) : 0;
}

/**
 * Get the waiting status to set when a tool's timeout fires.
 * @returns 'approval' | 'input' | null
 */
export function getWaitingStatus(toolName: string): string | null {
  const cat = getToolCategory(toolName);
  return cat ? (WAITING_REASONS[cat] || null) : null;
}

/**
 * Get the human-readable waitingDetail label for a tool.
 */
export function getWaitingLabel(toolName: string, detail: string): string | null {
  const cat = getToolCategory(toolName);
  if (!cat) return null;
  const status = WAITING_REASONS[cat];
  const labelFn = WAITING_LABELS[status];
  return labelFn ? labelFn(toolName, detail) : null;
}

// ---- Permission Flag Reconstruction ----

/**
 * Reconstruct Claude CLI permission flags from permissionMode if not already present
 * in the base command. This is a fallback for when startupCommand wasn't captured
 * (e.g. jq not installed, PID detection failed) or when restoring from workspace snapshot.
 *
 * Known permissionMode values from Claude Code:
 * - "default" / "plan" → no extra flags
 * - "bypassPermissions" / "dangerously_skip_permissions" → --dangerously-skip-permissions
 * - "auto-edit" / "auto_edit" → --permission-mode auto-edit (or "auto-accept edits")
 * - "full-auto" / "full_auto" → --permission-mode full-auto (or --yolo)
 *
 * The regex-based approach ensures we don't double-add flags already in the command.
 */
export function reconstructPermissionFlags(baseCmd: string, permissionMode?: string | null): string {
  if (!permissionMode) return baseCmd;

  const mode = permissionMode.toLowerCase().replace(/[_\s]+/g, '-');

  // --dangerously-skip-permissions (bypass, skip, dangerously, yolo)
  if (/bypass|dangerously|skip|yolo/.test(mode)) {
    if (!baseCmd.includes('--dangerously-skip-permissions')) {
      return `${baseCmd} --dangerously-skip-permissions`;
    }
    return baseCmd;
  }

  // --permission-mode <value> variants
  // Already has a --permission-mode flag → don't add
  if (/--permission-mode/.test(baseCmd)) return baseCmd;

  if (/full-?auto/.test(mode)) {
    return `${baseCmd} --permission-mode full-auto`;
  }
  if (/auto-?edit/.test(mode)) {
    return `${baseCmd} --permission-mode auto-edit`;
  }

  // "default", "plan", or unknown → no flag needed
  return baseCmd;
}

/**
 * Effort levels accepted by Claude Code's `--effort` launch flag. `ultracode` is
 * NOT in this set — it is a menu-only level (xhigh effort + standing multi-agent
 * permission) and the flag silently falls back to the default when given it.
 * Instead, ultracode launches at its valid base level `--effort xhigh` (see
 * `applyClaudeLaunchFlags`) and is upgraded to true ultracode via a post-startup
 * `/effort ultracode` slash command (see sshManager / ptyHost auto-inject).
 */
export const FLAG_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Append `--model <model>` and `--effort <level>` launch flags to a Claude
 * command so model/effort are applied deterministically at launch — before the
 * first prompt runs — instead of via racy post-startup slash injection (which
 * was dropping the `/effort` keystrokes behind the `/model` re-render, leaving
 * effort at its `high` default).
 *
 * Only `claude` commands are touched; codex/gemini pass through unchanged. Flags
 * are inserted right after the leading `claude` token and skipped if already
 * present. `ultracode` is launched as `--effort xhigh` (its valid base level — the
 * raw `--effort ultracode` flag is rejected by the CLI) and upgraded to true
 * ultracode by the post-startup `/effort ultracode` slash injection.
 */
/**
 * Safe charset for a Claude `--model` value — mirrors the `model` field in the
 * session-creation Zod schema (`apiRouter.ts`). The value is interpolated
 * **unquoted** into the `--model` launch flag, so anything outside this set is a
 * shell-injection / glob hazard.
 */
const SAFE_MODEL_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Clean a possibly-contaminated model id before it is interpolated into a
 * launch command. Forks/popups inherit `origin.model`, and an older session can
 * carry a model polluted with a stripped ANSI bold escape (e.g.
 * `claude-opus-4-8[1m]`, captured from a bold-rendered model id with the ESC
 * byte lost) or a real `\x1b[1m…\x1b[0m` wrapper / trailing newline. Left as-is,
 * `--model claude-opus-4-8[1m]` reaches the shell unquoted and zsh treats
 * `[1m]` as a glob → "no matches found" → the launch fails.
 *
 * Strips real ANSI escapes and their ESC-stripped SGR leftovers, collapses to
 * the first whitespace-delimited token, and returns it only if it matches the
 * safe charset — otherwise `''` (caller drops the flag and Claude uses its
 * default model).
 */
export function sanitizeModelId(model: string | null | undefined): string {
  if (!model) return '';
  const cleaned = model
    // Real ANSI escape sequences (CSI + OSC).
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    // ESC-stripped SGR leftovers: "[1m", "[0m]", "[1;32m" — a real model id
    // never contains a bracket, so these can be removed wholesale.
    .replace(/\[[0-9;]*[A-Za-z]\]?/g, '')
    // Drop control chars / trailing junk, then keep the first token.
    .trim()
    .split(/\s+/)[0] ?? '';
  return SAFE_MODEL_RE.test(cleaned) ? cleaned : '';
}

/**
 * Clean any `--model <value>` (or `--model=<value>`) token already baked into a
 * command string — e.g. a stored `startupCommand` reused by clone/resume/fork, or
 * one launched before {@link sanitizeModelId} existed. The value is recovered to a
 * safe token (`claude-opus-4-8[1m]` → `claude-opus-4-8`), or the flag is dropped
 * when nothing safe remains. Without this, a contaminated `--model` survives into
 * the launch command unquoted and zsh treats `[1m]` as a glob → the spawn fails.
 */
export function sanitizeModelInCommand(command: string): string {
  return command.replace(/\s*--model(?:=|\s+)(\S+)/g, (_full, value: string) => {
    const clean = sanitizeModelId(value);
    return clean ? ` --model ${clean}` : '';
  });
}

/**
 * Env defaults for every dashboard-spawned PTY that may run Claude Code.
 *
 * Claude Code ≥ 2.1.150 defaults to its "fullscreen" alt-screen renderer,
 * which enables xterm mouse tracking (DECSET 1000/1002/1003/1006). Inside the
 * dashboard's xterm.js terminals that captures every drag, so text selection —
 * and with it the select-to-translate/explain AI popup — stops working, and
 * scrollback-based features (bookmarks, find, REVIEW snapshots) degrade.
 * `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` is the official opt-out: it forces
 * the classic main-screen renderer (no alt screen, no mouse capture) and takes
 * precedence over the user's `tui` setting. External terminals are unaffected —
 * this only applies to PTYs the dashboard spawns.
 */
export const CLAUDE_TUI_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
};

/**
 * Return a new env with CLAUDE_TUI_ENV_DEFAULTS applied for keys not already
 * present. A pre-existing value (e.g. a user exporting
 * CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0 to opt back into fullscreen) wins.
 */
export function withClaudeTuiEnvDefaults(env: Record<string, string>): Record<string, string> {
  const defaults = Object.fromEntries(
    Object.entries(CLAUDE_TUI_ENV_DEFAULTS).filter(([key]) => !(key in env)),
  );
  return { ...env, ...defaults };
}

export function applyClaudeLaunchFlags(
  command: string,
  model?: string | null,
  effortLevel?: string | null,
): string {
  if (!command.startsWith('claude')) return command;
  // First scrub any contaminated --model already present in the command (clone /
  // resume / fork reuse the stored startupCommand), then add flags only if still
  // missing — so a baked-in `claude-opus-4-8[1m]` can't reach the unquoted flag.
  const cleaned = sanitizeModelInCommand(command);
  const flags: string[] = [];
  const safeModel = sanitizeModelId(model);
  if (safeModel && !/--model\b/.test(cleaned)) flags.push(`--model ${safeModel}`);
  // ultracode can't be an --effort value; launch at its base (xhigh) so effort is
  // still a real CLI parameter, then /effort ultracode upgrades it once ready.
  const flagEffort = effortLevel === 'ultracode' ? 'xhigh' : effortLevel;
  if (flagEffort && FLAG_EFFORT_LEVELS.has(flagEffort) && !/--effort\b/.test(cleaned)) {
    flags.push(`--effort ${flagEffort}`);
  }
  if (flags.length === 0) return cleaned;
  return cleaned.replace(/^claude\b/, `claude ${flags.join(' ')}`);
}

/**
 * Append `-n "title"` to a Claude command for session naming.
 * Only applies to Claude CLI commands (starts with "claude").
 * Skips if the command already contains a `-n` flag.
 */
export function appendSessionName(command: string, sessionTitle?: string | null): string {
  if (!sessionTitle) return command;
  // Only Claude CLI supports -n flag
  if (!command.startsWith('claude')) return command;
  // Don't double-add if already present
  if (/ -n[ =]/.test(command) || / --name[ =]/.test(command)) return command;
  // Escape double quotes in the title
  const escaped = sessionTitle.replace(/"/g, '\\"');
  return `${command} -n "${escaped}"`;
}

/**
 * Strip `-n <value>` / `--name <value>` (and `=` form) from a Claude command,
 * along with its quoted-or-unquoted argument. Used when cloning/forking a
 * session so the new session can be given its own name (e.g. "Clone of X")
 * instead of inheriting the original session's `-n` flag.
 */
export function stripClaudeSessionName(command: string): string {
  return command
    .replace(/\s+(?:-n|--name)(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+(?:\s+(?!-)\S+)*)/g, '')
    .trim();
}

/**
 * Extracts the session name from a `-n`/`--name` flag in a command string.
 * Handles quoted (single/double) and unquoted multi-word values.
 * Returns null when no name flag is present.
 */
export function extractSessionName(command: string): string | null {
  const m = command.match(
    /(?:-n|--name)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+(?:\s+(?!-)\S+)*))/
  );
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
}
