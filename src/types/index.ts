/**
 * Barrel re-export for all shared types.
 * Import from '@/types' (Vite alias) or '../src/types/index.js' (server NodeNext).
 */

// Session
export type {
  SessionStatus,
  AnimationState,
  Emote,
  EventType,
  SessionSource,
  PromptEntry,
  ToolLogEntry,
  ResponseEntry,
  SessionEvent,
  SshConfig,
  ArchivedSession,
  Session,
  BufferedEvent,
  HandleEventResult,
  PendingResume,
  PendingLink,
  SessionSnapshot,
} from './session.js';

// Hook
export type {
  HookPayloadBase,
  SessionStartPayload,
  UserPromptSubmitPayload,
  PreToolUsePayload,
  PostToolUsePayload,
  PostToolUseFailurePayload,
  PermissionRequestPayload,
  StopPayload,
  SubagentStartPayload,
  SubagentStopPayload,
  SessionEndPayload,
  NotificationPayload,
  TeammateIdlePayload,
  TaskCompletedPayload,
  PreCompactPayload,
  HookPayload,
} from './hook.js';

// WebSocket
export type {
  HookTimingStats,
  HookEventStats,
  HookStats,
  SnapshotMessage,
  SessionUpdateMessage,
  SessionRemovedMessage,
  TeamUpdateMessage,
  HookStatsMessage,
  TerminalOutputMessage,
  TerminalReadyMessage,
  TerminalClosedMessage,
  ClearBrowserDbMessage,
  ServerMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
  TerminalDisconnectMessage,
  TerminalSubscribeMessage,
  UpdateQueueCountMessage,
  ReplayMessage,
  ClientMessage,
} from './websocket.js';

// Terminal
export type {
  Terminal,
  TerminalConfig,
  TerminalInfo,
  TmuxSessionInfo,
  SshKeyInfo,
} from './terminal.js';

// Team
export type {
  Team,
  TeamSerialized,
  PendingSubagent,
  TeamMemberConfig,
  TeamConfig,
  TeamLinkResult,
} from './team.js';

// API
export type {
  ApiResponse,
  HookStatsResponse,
  HookDensity,
  HooksStatusResponse,
  HooksInstallRequest,
  HooksInstallResponse,
  MqStatsResponse,
  ResetResponse,
  KillSessionRequest,
  KillSessionResponse,
  UpdateTitleRequest,
  UpdateLabelRequest,
  UpdateAccentColorRequest,
  SummarizeRequest,
  SummarizeResponse,
  ResumeSessionResponse,
  DeleteSessionResponse,
  SessionSourceResponse,
  SshConnectionConfig,
  CreateTerminalRequest,
  CreateTerminalResponse,
  ListTerminalsResponse,
  ListSshKeysResponse,
  TmuxSessionsRequest,
  TmuxSessionsResponse,
  TeamConfigResponse,
  TeamMemberTerminalResponse,
  DbSessionRow,
  DbPromptRow,
  DbResponseRow,
  DbToolCallRow,
  DbEventRow,
  DbNoteRow,
  SessionDetailResponse,
  SessionSearchResponse,
  SessionSearchParams,
  FullTextSearchResult,
  FullTextSearchResponse,
  AddNoteRequest,
} from './api.js';

// Settings
export type {
  ServerConfig,
  ToolCategory,
  ToolTimeoutConfig,
  WaitingReasonConfig,
  AutoIdleConfig,
  StatusAnimation,
  StatusAnimationConfig,
  CliSoundConfig,
  SoundSettings,
  AmbientPreset,
  AmbientSettings,
  LabelAlarmSettings,
  BrowserSettings,
} from './settings.js';

// Analytics
export type {
  AnalyticsSummary,
  ToolBreakdownEntry,
  ToolBreakdown,
  ActiveProject,
  HeatmapEntry,
  HeatmapData,
  DistinctProject,
} from './analytics.js';
