// callManager.ts — at most one voice call at a time.
//
// A new call replaces the one in progress, but only once its OpenAI session exists: a refused setup (bad SDP, no
// access) leaves the current call alone. A second start while one is still being set up is refused (CallBusyError),
// so two overlapping requests can never leave an unowned call billing beside the new one.

import log from '../logger.js';
import type { LiveSessionCreated, Sideband, CreateLiveInput } from './liveApi.js';
import type { VoiceCall } from './voiceCall.js';
import { frontInstructions } from './voiceText.js';

/** Who a call belongs to: this Mac, or the remote sign-in that started it. Only its owner may see or end it. */
export interface CallOwner {
  isLocal: boolean;
  /** A stable key for the caller (the phone's pairing id, the sign-in lineage); '' for this Mac. */
  key: string;
}

export interface CallManagerDeps {
  apiKey(): string | null;
  voice(): string;
  createSession(input: CreateLiveInput): Promise<LiveSessionCreated>;
  attach(apiKey: string, sessionId: string): Sideband;
  /** Starts the call on the attached sideband; the owner decides which sessions it may hear about and act on. */
  startCall(input: { sideband: Sideband; reattach: () => Sideband; owner: CallOwner }): VoiceCall;
  newId(): string;
  now(): number;
}

export class CallBusyError extends Error {
  constructor() {
    super('A call is already being set up');
    this.name = 'CallBusyError';
  }
}

export interface ActiveCall {
  callId: string;
  startedAt: number;
  owner: CallOwner;
}

export interface CallManager {
  start(input: { sdp: string; owner: CallOwner }): Promise<{ callId: string; sdp: string }>;
  end(callId: string, caller: CallOwner): boolean;
  active(): ActiveCall | null;
  /** Ends any call (server shutdown) and refuses calls still being set up. */
  close(): void;
}

/** This Mac may end any call; a remote caller only its own. */
export function mayControl(call: ActiveCall, caller: CallOwner): boolean {
  return caller.isLocal || (!call.owner.isLocal && call.owner.key !== '' && call.owner.key === caller.key);
}

export function createCallManager(deps: CallManagerDeps): CallManager {
  let current: (ActiveCall & { call: VoiceCall }) | null = null;
  let starting = false;
  let closed = false;

  function endCurrent(): void {
    const c = current;
    current = null;
    c?.call.end();
  }

  return {
    async start({ sdp, owner }) {
      const apiKey = deps.apiKey();
      if (apiKey === null) throw new Error('No OpenAI API key is set');
      if (starting) throw new CallBusyError();
      starting = true;
      try {
        const created = await deps.createSession({ apiKey, sdp, instructions: frontInstructions(), voice: deps.voice() });
        const reattach = (): Sideband => deps.attach(apiKey, created.sessionId);
        const call = deps.startCall({ sideband: reattach(), reattach, owner });
        if (closed) {
          call.end();
          throw new Error('The server is shutting down');
        }
        endCurrent();
        const entry = { callId: deps.newId(), startedAt: deps.now(), owner, call };
        current = entry;
        call.onEnded((reason) => {
          log.info('voice', `Call ${entry.callId} ended (${reason})`);
          if (current === entry) current = null;
        });
        log.info('voice', `Call ${entry.callId} started from ${owner.isLocal ? 'this Mac' : 'a remote device'}`);
        return { callId: entry.callId, sdp: created.sdp };
      } finally {
        starting = false;
      }
    },

    end(callId, caller) {
      if (!current || current.callId !== callId || !mayControl(current, caller)) return false;
      endCurrent();
      return true;
    },

    active: () => (current ? { callId: current.callId, startedAt: current.startedAt, owner: current.owner } : null),

    close() {
      closed = true;
      endCurrent();
    },
  };
}
