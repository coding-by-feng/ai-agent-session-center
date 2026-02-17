/**
 * Hook payload types for AI Agent Session Center.
 * Describes the JSON structure received from bash hook scripts.
 */

import type { EventType } from './session.js';

// ---------------------------------------------------------------------------
// Base Payload
// ---------------------------------------------------------------------------

/** Base fields present on every hook payload (enriched by dashboard-hook.sh) */
export interface HookPayloadBase {
  session_id: string;
  hook_event_name: EventType;
  cwd?: string;
  timestamp?: number;
  hook_sent_at?: number;

  // Process info (added by jq enrichment)
  claude_pid?: number;
  model?: string;

  // Terminal environment (added by jq enrichment)
  agent_terminal_id?: string;
  tty_path?: string;
  term_program?: string;
  tab_id?: string;
  vscode_pid?: number;
  tmux?: { pane: string };
  window_id?: string;
  is_ghostty?: boolean;
  wezterm_pane?: string;

  // Team / subagent enrichment
  parent_session_id?: string;
  agent_type?: string;
  agent_name?: string;
  agent_id?: string;
  team_name?: string;
  agent_color?: string;
}

// ---------------------------------------------------------------------------
// Per-Event Payloads
// ---------------------------------------------------------------------------

/** SessionStart event payload */
export interface SessionStartPayload extends HookPayloadBase {
  hook_event_name: 'SessionStart';
  source?: string;
  transcript_path?: string;
  permission_mode?: string;
}

/** UserPromptSubmit event payload */
export interface UserPromptSubmitPayload extends HookPayloadBase {
  hook_event_name: 'UserPromptSubmit';
  prompt?: string;
}

/** PreToolUse event payload */
export interface PreToolUsePayload extends HookPayloadBase {
  hook_event_name: 'PreToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** PostToolUse event payload */
export interface PostToolUsePayload extends HookPayloadBase {
  hook_event_name: 'PostToolUse';
  tool_name?: string;
}

/** PostToolUseFailure event payload */
export interface PostToolUseFailurePayload extends HookPayloadBase {
  hook_event_name: 'PostToolUseFailure';
  tool_name?: string;
  error?: string;
  message?: string;
}

/** PermissionRequest event payload */
export interface PermissionRequestPayload extends HookPayloadBase {
  hook_event_name: 'PermissionRequest';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_mode?: string;
}

/** Stop event payload */
export interface StopPayload extends HookPayloadBase {
  hook_event_name: 'Stop';
  response?: string;
  message?: string;
  stop_reason_str?: string;
}

/** SubagentStart event payload */
export interface SubagentStartPayload extends HookPayloadBase {
  hook_event_name: 'SubagentStart';
  agent_type?: string;
  agent_id?: string;
  agent_name?: string;
}

/** SubagentStop event payload */
export interface SubagentStopPayload extends HookPayloadBase {
  hook_event_name: 'SubagentStop';
}

/** SessionEnd event payload */
export interface SessionEndPayload extends HookPayloadBase {
  hook_event_name: 'SessionEnd';
  reason?: string;
}

/** Notification event payload */
export interface NotificationPayload extends HookPayloadBase {
  hook_event_name: 'Notification';
  message?: string;
  title?: string;
}

/** TeammateIdle event payload */
export interface TeammateIdlePayload extends HookPayloadBase {
  hook_event_name: 'TeammateIdle';
  agent_name?: string;
  agent_id?: string;
}

/** TaskCompleted event payload */
export interface TaskCompletedPayload extends HookPayloadBase {
  hook_event_name: 'TaskCompleted';
  task_description?: string;
  task_id?: string;
}

/** PreCompact event payload */
export interface PreCompactPayload extends HookPayloadBase {
  hook_event_name: 'PreCompact';
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

/** Union of all hook payloads (discriminated by hook_event_name) */
export type HookPayload =
  | SessionStartPayload
  | UserPromptSubmitPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | PostToolUseFailurePayload
  | PermissionRequestPayload
  | StopPayload
  | SubagentStartPayload
  | SubagentStopPayload
  | SessionEndPayload
  | NotificationPayload
  | TeammateIdlePayload
  | TaskCompletedPayload
  | PreCompactPayload
  | HookPayloadBase;
