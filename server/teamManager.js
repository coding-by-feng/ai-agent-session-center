/**
 * @module teamManager
 * Manages team/subagent hierarchies. Teams are auto-created when a SubagentStart event
 * matches a new session by working directory, or directly linked via CLAUDE_CODE_PARENT_SESSION_ID
 * env var (Priority 0). Tracks parent-child relationships and handles cleanup when team
 * members end (with 15s delay for the parent).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import log from './logger.js';
import { SESSION_STATUS } from './constants.js';

const teams = new Map();            // teamId -> { teamId, parentSessionId, childSessionIds: Set, teamName, createdAt }
const sessionToTeam = new Map();    // sessionId -> teamId
const pendingSubagents = [];        // { parentSessionId, parentCwd, agentType, timestamp }

/**
 * Find a pending subagent entry matching a new child session.
 * Matches by cwd (exact or parent/child path relationship).
 *
 * @param {string} childSessionId - The new session to try to match
 * @param {string} childCwd - The working directory of the child session
 * @param {Map} sessions - The sessions Map (needed for linkSessionToTeam)
 * @returns {object|null} { teamId, team } or null
 */
export function findPendingSubagentMatch(childSessionId, childCwd, sessions) {
  const now = Date.now();
  // Clean stale entries (>10s old)
  while (pendingSubagents.length > 0 && now - pendingSubagents[0].timestamp > 10000) {
    pendingSubagents.shift();
  }
  if (!childCwd || pendingSubagents.length === 0) return null;

  // Match by cwd — exact match or parent/child path relationship
  for (let i = pendingSubagents.length - 1; i >= 0; i--) {
    const pending = pendingSubagents[i];
    if (pending.parentSessionId === childSessionId) continue; // skip self
    const parentCwd = pending.parentCwd;
    if (parentCwd && (childCwd === parentCwd || childCwd.startsWith(parentCwd + '/') || parentCwd.startsWith(childCwd + '/'))) {
      // Found match — consume it
      pendingSubagents.splice(i, 1);
      return linkSessionToTeam(pending.parentSessionId, childSessionId, pending.agentType, sessions);
    }
  }
  return null;
}

/**
 * Directly link a child session to its parent using CLAUDE_CODE_PARENT_SESSION_ID.
 * This is Priority 0 matching — no path guessing needed.
 *
 * @param {string} childSessionId - The new child session ID
 * @param {string} parentSessionId - The parent session ID from env var
 * @param {string} agentType - e.g. 'task', 'research', etc.
 * @param {string|null} agentName - The agent's name (e.g. 'backend-engineer')
 * @param {string|null} teamName - Team name from env var (e.g. 'my-project')
 * @param {Map} sessions - The sessions Map
 * @returns {object|null} { teamId, team } or null if parent not found
 */
export function linkByParentSessionId(childSessionId, parentSessionId, agentType, agentName, teamName, sessions) {
  if (!parentSessionId || !childSessionId) return null;
  if (parentSessionId === childSessionId) return null;

  const parentSession = sessions.get(parentSessionId);
  if (!parentSession) {
    log.debug('session', `linkByParentSessionId: parent ${parentSessionId?.slice(0,8)} not found in sessions`);
    return null;
  }

  const result = linkSessionToTeam(parentSessionId, childSessionId, agentType, sessions);

  // Apply team name from env var if available
  if (teamName && result) {
    const team = teams.get(result.teamId);
    if (team) {
      team.teamName = teamName;
      result.team = serializeTeam(team);
    }
  }

  // Store agent name on the child session
  const childSession = sessions.get(childSessionId);
  if (childSession && agentName) {
    childSession.agentName = agentName;
  }

  // Try to read team config for additional member metadata
  const effectiveTeamName = teamName || (result ? teams.get(result.teamId)?.teamName : null);
  if (effectiveTeamName && childSession) {
    const config = readTeamConfig(effectiveTeamName);
    if (config && agentName && config.members) {
      const memberConfig = config.members[agentName];
      if (memberConfig) {
        if (memberConfig.tmuxPaneId) childSession.tmuxPaneId = memberConfig.tmuxPaneId;
        if (memberConfig.backendType) childSession.backendType = memberConfig.backendType;
        if (memberConfig.color) childSession.agentColor = memberConfig.color;
      }
    }
  }

  log.info('session', `linkByParentSessionId: ${childSessionId?.slice(0,8)} → parent ${parentSessionId?.slice(0,8)} (agent=${agentName || 'unknown'}, team=${teamName || 'auto'})`);
  return result;
}

/**
 * Read team configuration from ~/.claude/teams/{teamName}/config.json.
 * Returns null if file doesn't exist or is invalid.
 *
 * Expected format:
 * {
 *   "members": {
 *     "backend-engineer": { "tmuxPaneId": "%3", "backendType": "node", "color": "#00ff88" },
 *     "frontend-engineer": { "tmuxPaneId": "%4", "backendType": "browser", "color": "#ff8800" }
 *   }
 * }
 *
 * @param {string} teamName - Team name (used as directory name)
 * @returns {object|null} Parsed config or null
 */
export function readTeamConfig(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  // Sanitize team name to prevent path traversal
  const safeName = teamName.replace(/[^a-zA-Z0-9_\-. ]/g, '');
  if (!safeName) return null;

  const configPath = join(homedir(), '.claude', 'teams', safeName, 'config.json');
  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Config file doesn't exist or is invalid — that's fine
    return null;
  }
}

/**
 * Link a child session to a team (creating the team if needed).
 */
function linkSessionToTeam(parentId, childId, agentType, sessions) {
  const teamId = `team-${parentId}`;
  let team = teams.get(teamId);

  if (!team) {
    team = {
      teamId,
      parentSessionId: parentId,
      childSessionIds: new Set(),
      teamName: null,
      createdAt: Date.now()
    };
    teams.set(teamId, team);

    // Set team name from parent's project name
    const parentSession = sessions.get(parentId);
    if (parentSession) {
      team.teamName = `${parentSession.projectName} Team`;
      parentSession.teamId = teamId;
      parentSession.teamRole = 'leader';
      sessionToTeam.set(parentId, teamId);
    }
  }

  // Link child
  team.childSessionIds.add(childId);
  const childSession = sessions.get(childId);
  if (childSession) {
    childSession.teamId = teamId;
    childSession.teamRole = 'member';
    childSession.agentType = agentType;
  }
  sessionToTeam.set(childId, teamId);

  log.info('session', `Linked session ${childId} to team ${teamId} as ${agentType}`);
  return { teamId, team: serializeTeam(team) };
}

/**
 * Handle team cleanup when a member session ends.
 */
export function handleTeamMemberEnd(sessionId, sessions) {
  const teamId = sessionToTeam.get(sessionId);
  if (!teamId) return null;

  const team = teams.get(teamId);
  if (!team) return null;

  team.childSessionIds.delete(sessionId);
  sessionToTeam.delete(sessionId);

  // If parent ended and all children ended, clean up the team
  if (sessionId === team.parentSessionId) {
    const allChildrenEnded = [...team.childSessionIds].every(cid => {
      const s = sessions.get(cid);
      return !s || s.status === SESSION_STATUS.ENDED;
    });
    if (allChildrenEnded) {
      // Clean up team after a delay
      setTimeout(() => {
        teams.delete(teamId);
        sessionToTeam.delete(team.parentSessionId);
        for (const cid of team.childSessionIds) {
          sessionToTeam.delete(cid);
        }
      }, 15000);
    }
  }

  return { teamId, team: serializeTeam(team) };
}

/**
 * Add a pending subagent entry for team auto-detection.
 */
export function addPendingSubagent(parentSessionId, parentCwd, agentType, agentId) {
  pendingSubagents.push({
    parentSessionId,
    parentCwd,
    agentType: agentType || 'unknown',
    agentId: agentId || null,
    timestamp: Date.now()
  });
  // Prune stale entries (>30s old)
  const now = Date.now();
  while (pendingSubagents.length > 0 && now - pendingSubagents[0].timestamp > 30000) {
    pendingSubagents.shift();
  }
}

function serializeTeam(team) {
  if (!team) return null;
  return {
    teamId: team.teamId,
    parentSessionId: team.parentSessionId,
    childSessionIds: [...team.childSessionIds],
    teamName: team.teamName,
    createdAt: team.createdAt
  };
}

export function getTeam(teamId) {
  const team = teams.get(teamId);
  return team ? serializeTeam(team) : null;
}

export function getAllTeams() {
  const result = {};
  for (const [id, team] of teams) {
    result[id] = serializeTeam(team);
  }
  return result;
}

export function getTeamForSession(sessionId) {
  const teamId = sessionToTeam.get(sessionId);
  if (!teamId) return null;
  return getTeam(teamId);
}

export function getTeamIdForSession(sessionId) {
  return sessionToTeam.get(sessionId) || null;
}

/**
 * Get the tmux pane ID for a team member session.
 * Looks up the session's stored tmuxPaneId field (set during linkByParentSessionId).
 *
 * @param {string} teamId - The team ID
 * @param {string} sessionId - The member's session ID
 * @param {Map} sessions - The sessions Map
 * @returns {string|null} The tmux pane ID (e.g. "%5") or null
 */
export function getMemberTmuxPaneId(teamId, sessionId, sessions) {
  const team = teams.get(teamId);
  if (!team) return null;
  if (sessionId !== team.parentSessionId && !team.childSessionIds.has(sessionId)) return null;
  const session = sessions.get(sessionId);
  return session?.tmuxPaneId || null;
}

/**
 * Get the config file path for a team.
 *
 * @param {string} teamName - Team name
 * @returns {string} Absolute path to the team config file
 */
export function getTeamConfigPath(teamName) {
  const safeName = (teamName || '').replace(/[^a-zA-Z0-9_\-. ]/g, '');
  return join(homedir(), '.claude', 'teams', safeName, 'config.json');
}
