// promptWiring.ts — the prompt route (AASC-42) wired to the live server: sessions,
// terminals, the control baton, the hook signals and the queue-image store. Kept
// apart from promptRouter.ts so that the router and the submitter stay testable
// without the session store, and this wiring is testable on its own.

import type { Router } from 'express';
import { getSession, getSessionIdByTerminalId } from './sessionStore.js';
import { getForegroundProcess, getTerminals, writeToTerminal } from './sshManager.js';
import * as presence from './presenceManager.js';
import { clientIdFromRequest, requireVisibleSession } from './apiRouter.js';
import { isLocalRequest } from './requestLocality.js';
import { onTerminalHook } from './hookSignals.js';
import { resolveQueueImage } from './queueImages.js';
import { isAgentProcessName } from './mobile/phoneProfile.js';
import { createPromptRouter } from './promptRouter.js';
import { createPromptSubmitter, type PromptSessionView } from './promptSubmit.js';

const terminalExists = (terminalId: string): boolean => getTerminals().some((t) => t.terminalId === terminalId);

/** The session that owns a terminal now, as the submitter reads it. */
function sessionOfTerminal(terminalId: string): PromptSessionView | null {
  const sessionId = getSessionIdByTerminalId(terminalId);
  const session = sessionId ? getSession(sessionId) : null;
  return session ? { sessionId: session.sessionId, status: session.status, userCancelledAt: session.userCancelledAt ?? null } : null;
}

export function createServerPromptRouter(): Router {
  const submitter = createPromptSubmitter({
    write: (terminalId, data) => {
      if (!terminalExists(terminalId)) return false;
      writeToTerminal(terminalId, data);
      return true;
    },
    sessionOfTerminal,
    isAgentForeground: (terminalId) => isAgentProcessName(getForegroundProcess(terminalId)),
    onTerminalHook,
  });
  return createPromptRouter({
    requireVisibleSession,
    isLocal: isLocalRequest,
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
