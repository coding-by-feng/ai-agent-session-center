// wiring.ts — the voice call wired to the live server: the settings file, the central registry, the session store,
// the shared prompt submitter, the hook signals, the transcripts and the WebSocket broadcast. Kept apart from the
// modules it joins so each of them stays testable without the server.

import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import type { Router } from 'express';
import type { Session } from '../../src/types/session.js';
import type { SessionCentralMarker } from '../../src/types/central.js';
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import { getAllSessions, getSession } from '../sessionStore.js';
import { onBroadcast } from '../wsManager.js';
import { onTerminalHook } from '../hookSignals.js';
import { isLocalRequest } from '../requestLocality.js';
import { extractToken, getTokenLineage } from '../authManager.js';
import { PHONE_PROMPTS_PER_MINUTE } from '../mobile/phoneProfile.js';
import { canSeeSession } from '../sessionVisibility.js';
import { WS_TYPES } from '../constants.js';
import { createServerPromptSubmitter } from '../promptWiring.js';
import { centrals, resolveCentralSession } from '../mcp/centrals.js';
import { isMcpEnabled } from '../mcp/runtime.js';
import { locateTranscript } from '../chat/transcriptLocator.js';
import { readClaudeChatPage } from '../chat/claudeTranscript.js';
import { readCodexChatPage } from '../chat/codexTranscript.js';
import { ASSISTANT_TEXT_CAP_MAX } from '../chat/chatEntries.js';
import { createBrain, findBrain, type BrainDeps, type BrainEntry, type BrainSession } from './brain.js';
import { createCallManager, type CallManager } from './callManager.js';
import type { DigestSession } from './digest.js';
import { attachSideband, createLiveSession, type SidebandSocketLike } from './liveApi.js';
import { startVoiceCall } from './voiceCall.js';
import { createVoiceRouter, type BrainStatus } from './voiceRouter.js';
import { readVoiceSettings, saveVoiceSettings } from './voiceSettings.js';

const markerOf = (s: Session): SessionCentralMarker | undefined => (s as Session & { central?: SessionCentralMarker }).central;

const allSessions = (): Session[] => Object.values(getAllSessions());

function toBrainSession(s: Session, centralId: string): BrainSession {
  return {
    sessionId: s.sessionId,
    terminalId: s.terminalId ?? null,
    status: s.status,
    title: sessionDisplayTitle(s),
    projectName: s.projectName,
    remoteVisible: s.remoteVisible === true,
    centralId,
    lastActivityAt: s.lastActivityAt,
  };
}

/** A session's transcript entries, newest last (the same readers as the phone Chat). */
async function readEntries(b: BrainSession): Promise<readonly BrainEntry[] | null> {
  const session = getSession(b.sessionId);
  if (!session) return null;
  const location = await locateTranscript(session);
  if (!location) return null;
  const read = location.cli === 'codex' ? readCodexChatPage : readClaudeChatPage;
  const page = await read(location.path, { assistantCap: ASSISTANT_TEXT_CAP_MAX });
  return page.entries;
}

function brainDeps(): BrainDeps {
  const submitter = createServerPromptSubmitter();
  return {
    centrals: () => centrals.list().map((r) => ({ centralId: r.centralId, kind: r.kind })),
    preferredCentralId: () => readVoiceSettings().brainCentralId,
    sessionOfCentral: (id) => {
      const s = resolveCentralSession(id, allSessions());
      return s ? toBrainSession(s, id) : null;
    },
    submit: (req) => submitter.submit(req),
    onTerminalHook,
    readEntries,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function digestSessions(isLocal: boolean): DigestSession[] {
  return allSessions()
    .filter((s) => canSeeSession(isLocal, s))
    .map((s) => ({
      sessionId: s.sessionId,
      title: sessionDisplayTitle(s),
      status: s.status,
      lastActivityAt: s.lastActivityAt,
      isCentral: markerOf(s) !== undefined,
    }));
}

const SESSION_MESSAGES: ReadonlySet<string> = new Set([WS_TYPES.SESSION_UPDATE, WS_TYPES.SESSION_REMOVED, WS_TYPES.SNAPSHOT]);

export interface ServerVoice {
  router: Router;
  close(): void;
}

export function createServerVoice(): ServerVoice {
  const bDeps = brainDeps();
  const brain = createBrain(bDeps);

  const brainStatus = (): BrainStatus => {
    if (!isMcpEnabled()) return { state: 'centrals_off', centralId: null, title: null, shared: false };
    const found = findBrain(bDeps);
    if ('problem' in found) return { state: found.problem, centralId: null, title: null, shared: false };
    return { state: 'ready', centralId: found.centralId, title: found.session.title, shared: found.session.remoteVisible };
  };

  const calls: CallManager = createCallManager({
    apiKey: () => readVoiceSettings().apiKey,
    voice: () => readVoiceSettings().voice,
    createSession: (input) => createLiveSession(input),
    attach: (apiKey, sessionId) => attachSideband({
      apiKey,
      sessionId,
      connect: (url, headers) => new WebSocket(url, { headers }) as unknown as SidebandSocketLike,
    }),
    startCall: ({ sideband, reattach, owner }) => startVoiceCall({
      sideband,
      reattach,
      brain,
      isLocal: owner.isLocal,
      // A phone's questions count like its Sends (phoneProfile's prompt budget); this Mac's are not limited.
      asksPerMinute: owner.isLocal ? undefined : PHONE_PROMPTS_PER_MINUTE,
      sessions: () => digestSessions(owner.isLocal),
      onSessionsChanged: (listener) => onBroadcast((m) => {
        if (SESSION_MESSAGES.has((m as { type?: string }).type ?? '')) listener();
      }),
    }),
    newId: () => `call_${randomBytes(9).toString('base64url')}`,
    now: Date.now,
  });

  const router = createVoiceRouter({
    isLocal: (req) => isLocalRequest(req),
    callerKey: (req) => getTokenLineage(extractToken(req)) ?? '',
    settings: () => readVoiceSettings(),
    saveSettings: (patch) => saveVoiceSettings(patch),
    brain: brainStatus,
    startCall: (input) => calls.start(input),
    endCall: (id, caller) => calls.end(id, caller),
    activeCall: () => calls.active(),
  });

  return { router, close: () => calls.close() };
}
