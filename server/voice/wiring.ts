// wiring.ts — the voice call wired to the live server: the settings file, the central registry, the session store,
// the shared prompt submitter, the hook signals, the transcripts and the WebSocket broadcast. Kept apart from the
// modules it joins so each of them stays testable without the server.

import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { Router } from 'express';
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
import { collectCallProgress, type CollectSession } from './callProgress.js';
import type { McpTaskState } from '../../src/types/mcpEvents.js';
import type { DigestSession } from './digest.js';
import { briefing, type ContextSession, type SkillEntry } from './voiceContext.js';
import { getCommandIndex } from '../commandIndex.js';
import { toSessionCard } from '../mcp/scope.js';
import { attachSideband, createLiveSession, type SidebandSocketLike } from './liveApi.js';
import { startVoiceCall, type VoiceCall } from './voiceCall.js';
import { createVoiceRouter, dictateBodyParser, type BrainStatus } from './voiceRouter.js';
import { readVoiceSettings, saveVoiceSettings } from './voiceSettings.js';
import { transcribeAudio } from './dictation.js';
import { dbHandle } from '../db.js';
import { runPrint } from '../claudePrint.js';
import type { SqlDatabase } from '../mcp/activity.js';
import type { SettingChange } from '../mcp/runtimeChange.js';
import { settingNote } from './voiceText.js';
import { createCallMemory, memoryBlock } from './callMemory.js';
import { extractFromCall, EXTRACT_CLAUDE_ARGS, EXTRACT_TIMEOUT_MS } from './callMemoryExtract.js';
import { createMemoryRouter } from './memoryRouter.js';

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

/** The project folders of the sessions this caller can see: the scopes call memory may use for it. */
function visibleProjects(isLocal: boolean): string[] {
  const out = new Set<string>();
  for (const s of allSessions()) if (canSeeSession(isLocal, s) && s.projectPath) out.add(s.projectPath);
  return [...out];
}

function contextSessions(isLocal: boolean): ContextSession[] {
  return allSessions()
    .filter((s) => canSeeSession(isLocal, s))
    .map((s) => ({
      sessionId: s.sessionId,
      title: sessionDisplayTitle(s),
      status: s.status,
      cli: toSessionCard(s, []).cli,
      projectName: s.projectName ?? '',
      remark: s.remark ?? '',
      summary: s.summary ?? '',
      prompts: (s.promptHistory ?? []).slice(-12).map((p) => p.text),
      lastActivityAt: s.lastActivityAt,
      isCentral: markerOf(s) !== undefined,
    }));
}

/**
 * The skills and commands a worker could be asked to run, from both CLIs' catalogs for the home folder (cached 30 s by
 * getCommandIndex): built-in commands left out, a plugin's under its `plugin:name` slug, one entry per name.
 */
function catalogSkills(): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const cli of ['claude', 'codex'] as const) {
    for (const e of getCommandIndex(cli, null)) {
      if (e.source === 'builtin') continue;
      const name = e.pluginName ? `${e.pluginName}:${e.name}` : e.name;
      const had = byName.get(name);
      byName.set(name, had
        ? { ...had, clis: had.clis.includes(cli) ? had.clis : [...had.clis, cli] }
        : { name, description: e.description, clis: [cli] });
    }
  }
  return [...byName.values()];
}

const SESSION_MESSAGES: ReadonlySet<string> = new Set([WS_TYPES.SESSION_UPDATE, WS_TYPES.SESSION_REMOVED, WS_TYPES.SNAPSHOT]);

export interface ServerVoice {
  router: Router;
  close(): void;
}

/** Where the dictate route's own body parser mounts (server/index.ts, before the global parser). */
export const DICTATE_PATH = '/api/voice/dictate';
export { dictateBodyParser };

/** A session for the call's progress: its display title, and the live card for the visibility check. */
type ProgressSession = CollectSession & { card: Session };

const toProgressSession = (s: Session): ProgressSession => ({
  sessionId: s.sessionId,
  title: sessionDisplayTitle(s),
  status: s.status,
  toolLog: s.toolLog ?? [],
  card: s,
});

export interface ServerVoiceOptions {
  /** A central's tasks from the task ledger (server/mcp), for the call's progress; none when centrals are off. */
  tasks?(centralId: string): ReadonlyArray<{ taskId?: string; sessionId: string; state: McpTaskState; createdAt: number }>;
  /** Every model or effort change reaching a final state (server/mcp/runtimeChange.ts); none when centrals are off. */
  settingChanges?(listener: (change: SettingChange) => void): () => void;
}

export function createServerVoice(options: ServerVoiceOptions = {}): ServerVoice {
  const bDeps = brainDeps();
  const brain = createBrain(bDeps);

  const brainStatus = (): BrainStatus => {
    if (!isMcpEnabled()) return { state: 'centrals_off', centralId: null, title: null, shared: false };
    const found = findBrain(bDeps);
    if ('problem' in found) return { state: found.problem, centralId: null, title: null, shared: false };
    return { state: 'ready', centralId: found.centralId, title: found.session.title, shared: found.session.remoteVisible };
  };

  // What calls taught, kept only once the person says so (callMemory.ts); on the server's own database.
  const memory = createCallMemory({ db: () => dbHandle() as unknown as SqlDatabase });

  /** The briefing for one request, with what the person kept that fits it. */
  const briefingFor = (request: string, isLocal: boolean): string => {
    const kept = memoryBlock(memory.kept(), request, visibleProjects(isLocal));
    if (kept.used.length > 0) memory.touch(kept.used);
    return briefing({ request, sessions: contextSessions(isLocal), skills: catalogSkills(), now: Date.now(), memory: kept.text });
  };

  /** The Voice central now, or null. */
  const brainCentral = (): string | null => {
    const found = isMcpEnabled() ? findBrain(bDeps) : null;
    return found && 'centralId' in found ? found.centralId : null;
  };

  /** The sessions the Voice central gave work to since `startedAt`, session id → its newest task id. */
  const touchedSince = (startedAt: number) => (): ReadonlyMap<string, string | null> => {
    const centralId = brainCentral();
    if (centralId === null) return new Map();
    const tasks = (options.tasks?.(centralId) ?? []).filter((t) => t.createdAt >= startedAt);
    return new Map([...tasks].sort((a, b) => a.createdAt - b.createdAt).map((t) => [t.sessionId, t.taskId ?? null]));
  };

  /** Lines for the call when a change the Voice central asked for is final, for sessions this caller may see. */
  const settingNotes = (isLocal: boolean) => options.settingChanges
    ? (listener: (text: string) => void) => options.settingChanges!((c) => {
        if (c.state !== 'confirmed' && c.state !== 'not-applied' && c.state !== 'expired') return;
        if (c.centralId !== brainCentral()) return;
        const s = getSession(c.sessionId);
        if (!s || !canSeeSession(isLocal, s)) return;
        listener(settingNote({
          own: c.self,
          title: sessionDisplayTitle(s),
          kind: c.kind,
          value: c.value,
          applied: c.state === 'confirmed',
          reason: c.reason,
        }));
      })
    : undefined;

  /** After a call: propose what it taught (callMemoryExtract.ts); never in the way of the call itself. */
  const learnFrom = (call: VoiceCall, startedAt: number, isLocal: boolean): void => {
    call.onEnded(() => {
      void extractFromCall({
        lines: call.transcript(),
        durationMs: Date.now() - startedAt,
        context: { names: contextSessions(isLocal).map((s) => s.title).filter(Boolean), projects: visibleProjects(isLocal) },
        runModel: (prompt) => runPrint('claude', EXTRACT_CLAUDE_ARGS, prompt, EXTRACT_TIMEOUT_MS),
        memory,
        callId: `call-${startedAt}`,
      });
    });
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
    startCall: ({ sideband, reattach, owner }) => {
      const startedAt = Date.now();
      const call = startVoiceCall({
      sideband,
      reattach,
      brain,
      isLocal: owner.isLocal,
      // A phone's questions count like its Sends (phoneProfile's prompt budget); this Mac's are not limited.
      asksPerMinute: owner.isLocal ? undefined : PHONE_PROMPTS_PER_MINUTE,
      sessions: () => digestSessions(owner.isLocal),
      briefing: (request) => briefingFor(request, owner.isLocal),
      touched: touchedSince(startedAt),
      ...(options.settingChanges ? { onNote: settingNotes(owner.isLocal) } : {}),
      onSessionsChanged: (listener) => onBroadcast((m) => {
        if (SESSION_MESSAGES.has((m as { type?: string }).type ?? '')) listener();
      }),
      });
      learnFrom(call, startedAt, owner.isLocal);
      return call;
    },
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
    callProgress: (callId, caller) => {
      const found = calls.callFor(callId, caller);
      if (!found) return null;
      const brainNow = isMcpEnabled() ? findBrain(bDeps) : null;
      return collectCallProgress<ProgressSession>({
        call: found.call,
        startedAt: found.startedAt,
        now: Date.now(),
        central: brainNow && 'centralId' in brainNow ? { centralId: brainNow.centralId, sessionId: brainNow.session.sessionId } : null,
        tasks: (centralId) => options.tasks?.(centralId) ?? [],
        getSession: (id) => {
          const s = getSession(id);
          return s ? toProgressSession(s) : null;
        },
        canSee: (s) => canSeeSession(caller.isLocal, s.card),
      });
    },
    transcribe: (input) => transcribeAudio(input),
  });

  const all = Router();
  all.use(router);
  all.use(createMemoryRouter({
    isLocal: (req) => isLocalRequest(req),
    projectsFor: visibleProjects,
    memory,
    liveCall: () => {
      const active = calls.active();
      const found = active ? calls.callFor(active.callId, { isLocal: true, key: '' }) : null;
      return active && found ? { callId: `call-${found.startedAt}`, lines: found.call.transcript() } : null;
    },
  }));
  return { router: all, close: () => calls.close() };
}
