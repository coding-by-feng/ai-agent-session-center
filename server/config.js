// config.js — Extracted session status & approval detection configuration

// ---- Tool Categories for Approval Detection ----
// When PreToolUse fires, we start a timer. If PostToolUse doesn't arrive
// within the timeout, the tool is likely pending user interaction.
//
// Only tools that complete near-instantly when auto-approved can reliably
// trigger detection. Tools like Bash/Task can legitimately run for minutes,
// so we can't distinguish "slow execution" from "waiting for approval".

export const TOOL_CATEGORIES = {
  // Tools that complete instantly when auto-approved (3s timeout)
  fast: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit'],
  // Tools that ALWAYS require user interaction — not approval, but input (3s timeout)
  userInput: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
  // Tools that can be slow but not minutes-slow (15s timeout)
  medium: ['WebFetch', 'WebSearch'],
  // Everything else (Bash, Task, TodoWrite, Skill, etc.) — no timeout
};

export const TOOL_TIMEOUTS = {
  fast: 3000,
  userInput: 3000,
  medium: 15000,
};

// Status to set when each category's timeout fires
export const WAITING_REASONS = {
  fast: 'approval',     // "NEEDS YOUR APPROVAL"
  userInput: 'input',   // "WAITING FOR YOUR ANSWER"
  medium: 'approval',   // "NEEDS YOUR APPROVAL"
};

// Human-readable labels for waitingDetail per category
export const WAITING_LABELS = {
  approval: (toolName, detail) =>
    detail ? `Approve ${toolName}: ${detail}` : `Approve ${toolName}`,
  input: (toolName, _detail) => {
    if (toolName === 'AskUserQuestion') return 'Waiting for your answer';
    if (toolName === 'EnterPlanMode') return 'Review plan mode request';
    if (toolName === 'ExitPlanMode') return 'Review plan';
    return `Waiting for input on ${toolName}`;
  },
};

// ---- Auto-Idle Timeouts ----
// Sessions transition to idle/waiting if no activity for these durations (ms)
export const AUTO_IDLE_TIMEOUTS = {
  prompting: 30_000,    // prompting → waiting (user likely cancelled)
  waiting: 120_000,     // waiting → idle (2 min)
  working: 180_000,     // working → idle (3 min)
  approval: 600_000,    // approval → idle (10 min safety net)
  input: 600_000,       // input → idle (10 min safety net)
};

// ---- Animation State Mappings ----
export const STATUS_ANIMATIONS = {
  idle:      { animationState: 'Idle',    emote: null },
  prompting: { animationState: 'Walking', emote: 'Wave' },
  working:   { animationState: 'Running', emote: null },
  approval:  { animationState: 'Waiting', emote: null },
  input:     { animationState: 'Waiting', emote: null },
  waiting:   { animationState: 'Waiting', emote: 'ThumbsUp' },
  ended:     { animationState: 'Death',   emote: null },
};

// ---- Precomputed Tool → Category Lookup ----
// Built once at import time for O(1) lookups in hot path
const _toolToCategory = new Map();
for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
  for (const tool of tools) {
    _toolToCategory.set(tool, category);
  }
}

/**
 * Get the category for a tool name.
 * @returns {string|null} 'fast' | 'userInput' | 'medium' | null (no timeout)
 */
export function getToolCategory(toolName) {
  return _toolToCategory.get(toolName) || null;
}

/**
 * Get the approval/input timeout for a tool, or 0 if no detection applies.
 */
export function getToolTimeout(toolName) {
  const cat = getToolCategory(toolName);
  return cat ? (TOOL_TIMEOUTS[cat] || 0) : 0;
}

/**
 * Get the waiting status to set when a tool's timeout fires.
 * @returns {'approval'|'input'|null}
 */
export function getWaitingStatus(toolName) {
  const cat = getToolCategory(toolName);
  return cat ? (WAITING_REASONS[cat] || null) : null;
}

/**
 * Get the human-readable waitingDetail label for a tool.
 */
export function getWaitingLabel(toolName, detail) {
  const cat = getToolCategory(toolName);
  if (!cat) return null;
  const status = WAITING_REASONS[cat];
  const labelFn = WAITING_LABELS[status];
  return labelFn ? labelFn(toolName, detail) : null;
}
