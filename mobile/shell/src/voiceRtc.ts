// voiceRtc.ts — the audio side of a voice call: the microphone, a WebRTC peer to OpenAI, and the `oai-events` data
// channel that carries GPT-Live's transcript events (developers.openai.com/api/docs/guides/realtime-webrtc).
//
// The browser parts come in through RtcEnv, so the logic is tested without a browser. The offer is sent once ICE
// gathering completes (or after ICE_WAIT_MS), as OpenAI's own browser example does: the Mac posts it in one request.

/** Longest wait for ICE candidates before the offer is sent with what has been gathered. */
export const ICE_WAIT_MS = 3_000;

export interface TrackLike {
  enabled: boolean;
  stop(): void;
}

export interface MediaStreamLike {
  getAudioTracks(): TrackLike[];
  getTracks(): TrackLike[];
}

export interface ChannelLike {
  addEventListener(type: 'message', listener: (e: { data?: unknown }) => void): void;
  close(): void;
}

export interface PeerLike {
  readonly localDescription: { sdp: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  addTrack(track: TrackLike, stream: MediaStreamLike): unknown;
  createDataChannel(label: string): ChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: 'answer'; sdp: string }): Promise<void>;
  addEventListener(type: 'track', listener: (e: { streams?: readonly unknown[] }) => void): void;
  addEventListener(type: 'icegatheringstatechange' | 'connectionstatechange', listener: () => void): void;
  close(): void;
}

export interface RtcEnv {
  getMicrophone(): Promise<MediaStreamLike>;
  createPeer(): PeerLike;
  /** Plays the remote stream (a hidden autoplay <audio> outside the redrawn screen); returns the stop. */
  playRemote(stream: unknown): () => void;
}

export class RtcError extends Error {
  constructor(readonly code: 'microphone' | 'setup') {
    super(code);
    this.name = 'RtcError';
  }
}

export interface CallRtc {
  /** Turns the mic on and answers the SDP offer. Throws RtcError('microphone') when the mic is refused. */
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
  onEvent(listener: (event: unknown) => void): void;
  /** Told once, when the connection fails or closes from the other side. */
  onDropped(listener: () => void): void;
  close(): void;
}

export function createCallRtc(env: RtcEnv): CallRtc {
  let mic: MediaStreamLike | null = null;
  let peer: PeerLike | null = null;
  let channel: ChannelLike | null = null;
  let stopPlay: (() => void) | null = null;
  let closed = false;
  let dropped = false;
  const events: Array<(e: unknown) => void> = [];
  const drops: Array<() => void> = [];

  function gathered(p: PeerLike): Promise<void> {
    if (p.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ICE_WAIT_MS);
      p.addEventListener('icegatheringstatechange', () => {
        if (p.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  return {
    async offer() {
      let stream: MediaStreamLike;
      try {
        stream = await env.getMicrophone();
      } catch {
        throw new RtcError('microphone');
      }
      // Hung up while the microphone prompt was open: close() found nothing to stop, so let go of it here.
      if (closed) {
        for (const track of stream.getTracks()) track.stop();
        throw new RtcError('setup');
      }
      mic = stream;
      const p = env.createPeer();
      peer = p;
      for (const track of mic.getAudioTracks()) p.addTrack(track, mic);
      p.addEventListener('track', (e) => {
        const stream = e.streams?.[0];
        if (stream && !stopPlay && !closed) stopPlay = env.playRemote(stream);
      });
      p.addEventListener('connectionstatechange', () => {
        if ((p.connectionState === 'failed' || p.connectionState === 'closed') && !closed && !dropped) {
          dropped = true;
          for (const l of drops) l();
        }
      });
      // Created before the offer, as OpenAI's guide says, so it is part of the negotiation.
      channel = p.createDataChannel('oai-events');
      channel.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        let event: unknown;
        try {
          event = JSON.parse(e.data);
        } catch {
          return;
        }
        for (const l of events) l(event);
      });
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      await gathered(p);
      const sdp = p.localDescription?.sdp;
      if (!sdp) throw new RtcError('setup');
      return sdp;
    },

    async answer(sdp) {
      if (!peer) throw new RtcError('setup');
      await peer.setRemoteDescription({ type: 'answer', sdp });
    },

    setMuted(muted) {
      for (const track of mic?.getAudioTracks() ?? []) track.enabled = !muted;
    },

    onEvent: (l) => { events.push(l); },
    onDropped: (l) => { drops.push(l); },

    close() {
      if (closed) return;
      closed = true;
      for (const track of mic?.getTracks() ?? []) track.stop();
      stopPlay?.();
      channel?.close();
      peer?.close();
    },
  };
}

/**
 * The real browser parts, or null where WebRTC or the microphone API is missing. The remote audio element sits on
 * <body>, outside the app root the screens redraw, and is removed when the call stops.
 */
export function browserRtcEnv(): RtcEnv | null {
  if (typeof RTCPeerConnection === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }) as Promise<MediaStreamLike>,
    createPeer: () => new RTCPeerConnection() as unknown as PeerLike,
    playRemote: (stream) => {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audio.hidden = true;
      audio.srcObject = stream as MediaStream;
      document.body.append(audio);
      return () => {
        audio.srcObject = null;
        audio.remove();
      };
    },
  };
}
