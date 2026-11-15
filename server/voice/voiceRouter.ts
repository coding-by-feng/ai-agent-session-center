// voiceRouter.ts — the voice call's routes (mounted under /api, after authMiddleware and the phone allow-list).
//
//   GET  /voice/status            can a call start: key set, Voice central ready (and shared), a call in progress
//   POST /voice/call  { sdp }     start a call from the device's WebRTC SDP offer → { callId, sdp: answer }
//   POST /voice/call/:id/end      end that call (this Mac: any call; a remote device: only its own)
//   GET  /voice/settings          this Mac only: the settings, never the key
//   PUT  /voice/settings          this Mac only: { apiKey?, voice?, brainCentralId? }
//
// A paired phone may start a call only when the Voice central is shared with remote devices: what the central says
// can name any session, and a phone can already read a shared central's chat, so sharing it is the consent.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import log from '../logger.js';
import { CallBusyError, mayControl, type ActiveCall, type CallOwner } from './callManager.js';
import { LiveApiError, type LiveFailure } from './liveApi.js';
import {
  publicVoiceSettings, VOICE_NAME_RE, type VoiceSettings, type VoiceSettingsPatch,
} from './voiceSettings.js';

/** An SDP offer is a few kilobytes; OpenAI's own example caps the request at 64 KB. */
export const SDP_MAX = 64 * 1024;

/** Calls that may be started per minute, from all devices together: each one opens a paid OpenAI session. */
export const CALL_STARTS_PER_MINUTE = 6;

export type BrainState = 'ready' | 'no_central' | 'not_running' | 'centrals_off';

export interface BrainStatus {
  state: BrainState;
  centralId: string | null;
  title: string | null;
  /** Shared with remote devices (`remoteVisible`): a phone may call only then. */
  shared: boolean;
}

export interface VoiceRouterDeps {
  isLocal(req: Request): boolean;
  /** A stable key for a remote caller's sign-in (its token lineage), or '' when there is none. */
  callerKey(req: Request): string;
  settings(): VoiceSettings;
  saveSettings(patch: VoiceSettingsPatch): VoiceSettings;
  brain(): BrainStatus;
  startCall(input: { sdp: string; owner: CallOwner }): Promise<{ callId: string; sdp: string }>;
  endCall(callId: string, caller: CallOwner): boolean;
  activeCall(): ActiveCall | null;
  now?(): number;
}

const callBody = z.object({ sdp: z.string().min(1).max(SDP_MAX) }).strict();

const settingsBody = z.object({
  apiKey: z.string().trim().min(20).max(300).regex(/^\S+$/).nullable().optional(),
  voice: z.string().regex(VOICE_NAME_RE).optional(),
  brainCentralId: z.string().min(1).max(128).nullable().optional(),
}).strict();

const BRAIN_REFUSAL: Record<Exclude<BrainState, 'ready'>, string> = {
  no_central: 'No Voice central: keep exactly one global central session running in AASC.',
  not_running: 'The Voice central is not running: reconnect it in AASC.',
  centrals_off: 'Central sessions are off: turn them on in Settings → ADVANCED and restart AASC.',
};

const LIVE_REFUSAL: Record<LiveFailure, string> = {
  key: 'OpenAI refused the API key: check it in Settings → Voice.',
  access: 'This OpenAI project has no GPT-Live access.',
  rate: 'OpenAI is rate-limiting voice sessions: try again shortly.',
  bad_request: 'OpenAI refused the call setup.',
  upstream: 'OpenAI failed to start the call: try again.',
  network: 'This Mac could not reach OpenAI.',
};

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ success: false, code, error });
}

export function createVoiceRouter(deps: VoiceRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const starts: number[] = [];

  const ownerOf = (req: Request): CallOwner => {
    const isLocal = deps.isLocal(req);
    return { isLocal, key: isLocal ? '' : deps.callerKey(req) };
  };

  /** Counts a start against the per-minute budget; false when it is spent. */
  const takeStart = (): boolean => {
    const at = now();
    while (starts.length > 0 && at - starts[0] >= 60_000) starts.shift();
    if (starts.length >= CALL_STARTS_PER_MINUTE) return false;
    starts.push(at);
    return true;
  };

  router.get('/voice/status', (req: Request, res: Response) => {
    const s = deps.settings();
    const brain = deps.brain();
    // A device the central is not shared with learns only that it exists, not what it is called.
    const caller = ownerOf(req);
    const seen = caller.isLocal || brain.shared ? brain : { ...brain, centralId: null, title: null };
    // Another device learns only that a call is on, never its id (the id is what ends it).
    const active = deps.activeCall();
    const call = active
      ? { callId: mayControl(active, caller) ? active.callId : null, startedAt: active.startedAt, mine: !caller.isLocal && mayControl(active, caller) }
      : null;
    res.json({
      success: true,
      data: { configured: s.apiKey !== null, voice: s.voice, brain: seen, call },
    });
  });

  router.post('/voice/call', async (req: Request, res: Response) => {
    const parsed = callBody.safeParse(req.body);
    if (!parsed.success) { refuse(res, 400, 'invalid', `sdp is required, at most ${SDP_MAX} characters`); return; }
    if (deps.settings().apiKey === null) { refuse(res, 409, 'no_key', 'Add an OpenAI API key in Settings → Voice on this Mac.'); return; }
    const brain = deps.brain();
    if (brain.state !== 'ready') { refuse(res, 409, brain.state, BRAIN_REFUSAL[brain.state]); return; }
    const owner = ownerOf(req);
    if (!owner.isLocal && !brain.shared) {
      refuse(res, 403, 'not_shared', 'Share the Voice central with remote devices (📡 on its card) to call it from this device.');
      return;
    }
    if (!takeStart()) { refuse(res, 429, 'rate_limited', 'Too many calls in a minute: wait a moment and call again.'); return; }
    try {
      const call = await deps.startCall({ sdp: parsed.data.sdp, owner });
      res.status(201).json({ success: true, data: call });
    } catch (err) {
      if (err instanceof CallBusyError) { refuse(res, 409, 'busy', 'Another call is starting: try again in a moment.'); return; }
      if (err instanceof LiveApiError) {
        log.warn('voice', `Starting a call failed (${err.reason}, HTTP ${err.status}): ${err.message}`);
        refuse(res, 502, err.reason, LIVE_REFUSAL[err.reason]);
        return;
      }
      log.error('voice', `Starting a call failed: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, 500, 'failed', 'The call could not start.');
    }
  });

  router.post('/voice/call/:id/end', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!deps.endCall(id, ownerOf(req))) { refuse(res, 404, 'not_found', 'No such call'); return; }
    res.json({ success: true, data: { ended: id } });
  });

  router.get('/voice/settings', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) { refuse(res, 404, 'not_found', 'Not found'); return; }
    res.json({ success: true, data: publicVoiceSettings(deps.settings()) });
  });

  router.put('/voice/settings', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) { refuse(res, 404, 'not_found', 'Not found'); return; }
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) { refuse(res, 400, 'invalid', 'apiKey (20–300 characters, or null), voice (a voice name) or brainCentralId'); return; }
    try {
      const saved = deps.saveSettings(parsed.data as VoiceSettingsPatch);
      res.json({ success: true, data: publicVoiceSettings(saved) });
    } catch (err) {
      log.error('voice', `Saving voice settings failed: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, 500, 'failed', 'Could not save the voice settings');
    }
  });

  return router;
}
