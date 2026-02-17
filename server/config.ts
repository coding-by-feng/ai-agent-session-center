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
  waiting: 120_000,     // waiting -> idle (2 min)
  working: 180_000,     // working -> idle (3 min)
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
