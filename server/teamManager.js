/**
 * @module teamManager
 * Manages team/subagent hierarchies. Teams are auto-created when a SubagentStart event
 * matches a new session by working directory. Tracks parent-child relationships and
 * handles cleanup when team members end (with 15s delay for the parent).
 */
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
