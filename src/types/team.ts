/**
 * Team / subagent types for AI Agent Session Center.
 */

// ---------------------------------------------------------------------------
// Internal (server-side, with Set)
// ---------------------------------------------------------------------------

/** Internal team object stored in the teams Map (uses Set for children) */
export interface Team {
  teamId: string;
  parentSessionId: string;
  childSessionIds: Set<string>;
  teamName: string | null;
  createdAt: number;
}

/** Serialized team object (Set converted to array for JSON / WebSocket) */
export interface TeamSerialized {
  teamId: string;
  parentSessionId: string;
  childSessionIds: string[];
  teamName: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Pending Subagent (for path-based auto-detection)
// ---------------------------------------------------------------------------

/** Pending subagent entry used for team auto-detection */
export interface PendingSubagent {
  parentSessionId: string;
  parentCwd: string;
  agentType: string;
  agentId: string | null;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Team Config (from ~/.claude/teams/{name}/config.json)
// ---------------------------------------------------------------------------

/** Per-member configuration in team config file */
export interface TeamMemberConfig {
  tmuxPaneId?: string;
  backendType?: string;
  color?: string;
}

/** Team configuration file structure */
export interface TeamConfig {
  members?: Record<string, TeamMemberConfig>;
}

// ---------------------------------------------------------------------------
// Linking results
// ---------------------------------------------------------------------------

/** Result from linkSessionToTeam / linkByParentSessionId */
export interface TeamLinkResult {
  teamId: string;
  team: TeamSerialized;
}
