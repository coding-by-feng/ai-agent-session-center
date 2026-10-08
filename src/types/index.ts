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
  SubagentRun,
  SubagentRunStatus,
  BackgroundTask,
  ResponseEntry,
  SessionEvent,
  SshConfig,
  ArchivedSession,
  PlanCli,
  PlanUsage,
  PlanUsageWindow,
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
  PostCompactPayload,
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
  DevicePresence,
  ControlHolderView,
  PresenceUpdateMessage,
  ControlDeniedMessage,
  ControlRequestedMessage,
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
  PromptKind,
  PromptTraceRow,
  PromptSearchParams,
  PromptSearchResponse,
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

// Shortcut
export type {
  KeyCombo,
  ShortcutActionId,
  ShortcutBinding,
} from './shortcut.js';

// Agenda
export type {
  AgendaPriority,
  AgendaTask,
  AgendaFilter,
} from './agenda.js';

// Analytics
export type {
  DistinctProject,
} from './analytics.js';

// Agent Resources (RESOURCES tab)
export type {
  ResourceType,
  ResourceAgent,
  ResourceScope,
  ResourceOrigin,
  ResourceFormat,
  RepoStatus,
  ResourceSummary,
  FindingCode,
  FindingSeverity,
  ResourceFinding,
  DiscoveryEvidence,
  ResourceProject,
  CoverageCategory,
  CoverageStatus,
  CoverageEntry,
  ScanState,
  ScanProgress,
  ResourceRoots,
  ResourceCatalog,
  ResourceFile,
  ResourceFieldKind,
  ResourceField,
  ResourceDetail,
  ResourceFileContent,
  CompareTarget,
  ResourceCompareFile,
  ResourceCompare,
  ResourcesApiResponse,
} from './resources.js';
