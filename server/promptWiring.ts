// promptWiring.ts — the prompt route (AASC-42) wired to the live server: sessions,
// terminals, the control baton, the hook signals and the queue-image store. Kept
// apart from promptRouter.ts so that the router and the submitter stay testable
// without the session store, and this wiring is testable on its own.

import type { Request, Router } from 'express';
import { getSession } from './sessionStore.js';
import { getForegroundProcess, getTerminals, writeToTerminal } from './sshManager.js';
import * as presence from './presenceManager.js';
import { clientIdFromRequest, requireVisibleSession } from './apiRouter.js';
import { isLocalRequest } from './requestLocality.js';
import { canSeeSession } from './sessionVisibility.js';
import { extractToken, getTokenLineage, isLineageAlive } from './authManager.js';
import { onTerminalHook } from './hookSignals.js';
import { resolveQueueImage } from './queueImages.js';
import { isAgentProcessName } from './mobile/phoneProfile.js';
import { createPromptRouter } from './promptRouter.js';
import { createPromptSubmitter, type PromptSubmitter } from './promptSubmit.js';

const terminalExists = (terminalId: string): boolean => getTerminals().some((t) => t.terminalId === terminalId);

/**
 * May the remote caller behind `req` still reach a session? Its sign-in (token
 * lineage, which survives token refreshes) must still be alive: removing a phone
 * revokes its tokens, signing out removes them. And the session must still be
 * shared with remote devices: the same rule as the /sessions/:id gate.
 */
function remoteAccess(req: Request): (sessionId: string) => boolean {
  const lineage = getTokenLineage(extractToken(req));
  return (sessionId) => lineage !== null && isLineageAlive(lineage) && canSeeSession(false, getSession(sessionId));
}

/**
 * A submitter on the live terminals, sessions and hook signals: the prompt route's, and the one a central's task
 * cancel presses its Esc through (server/mcp/deliverWiring.ts). An Esc needs no place in a terminal's line of
 * prompts, so the two need not share one.
 */
export function createServerPromptSubmitter(): PromptSubmitter {
  return createPromptSubmitter({
    write: (terminalId, data) => {
      if (!terminalExists(terminalId)) return false;
      writeToTerminal(terminalId, data);
      return true;
    },
    getSession,
    isAgentForeground: (terminalId) => isAgentProcessName(getForegroundProcess(terminalId)),
    onTerminalHook,
  });
}

export function createServerPromptRouter(): Router {
  const submitter = createServerPromptSubmitter();
  return createPromptRouter({
    requireVisibleSession,
    isLocal: isLocalRequest,
    remoteAccess,
    clientIdOf: clientIdFromRequest,
    getSession,
    terminalExists,
    foregroundProcess: getForegroundProcess,
    noteControlActivity: presence.noteControlActivity,
    canControl: presence.canControl,
    controller: presence.getController,
    resolveImage: (id) => resolveQueueImage(id),
    submitter,
  });
}
