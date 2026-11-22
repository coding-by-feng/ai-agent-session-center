import { describe, it, expect, vi } from 'vitest';
import { createCallRtc, RtcError, ICE_WAIT_MS, type RtcEnv, type PeerLike, type ChannelLike } from './voiceRtc.js';

type Listener = (e: unknown) => void;

class Emitter {
  private ls = new Map<string, Set<Listener>>();
  addEventListener(type: string, l: Listener): void {
    const set = this.ls.get(type) ?? new Set();
    set.add(l);
    this.ls.set(type, set);
  }
  fire(type: string, e: unknown = {}): void { for (const l of this.ls.get(type) ?? []) l(e); }
}

class FakeChannel extends Emitter implements ChannelLike {
  label = '';
  closed = false;
  close(): void { this.closed = true; }
}

class FakePeer extends Emitter implements PeerLike {
  channel = new FakeChannel();
  tracks: unknown[] = [];
  localDescription: { sdp: string } | null = null;
  remote: unknown = null;
  iceGatheringState = 'new';
  connectionState = 'new';
  closed = false;
  addTrack(track: unknown): unknown { this.tracks.push(track); return {}; }
  createDataChannel(label: string): ChannelLike { this.channel.label = label; return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0 partial' }; }
  async setLocalDescription(d: { sdp?: string }) { this.localDescription = { sdp: `${d.sdp} +candidates` }; }
  async setRemoteDescription(d: unknown) { this.remote = d; }
  close(): void { this.closed = true; }
}

function env(over: Partial<RtcEnv> = {}) {
  const peer = new FakePeer();
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stopPlay = vi.fn();
  const e: RtcEnv = {
    getMicrophone: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })),
    createPeer: () => peer,
    playRemote: vi.fn(() => stopPlay),
    ...over,
  };
  return { e, peer, track, stopPlay };
}

describe('createCallRtc', () => {
  it('opens the mic, adds its track and the oai-events channel, and answers the gathered offer', async () => {
    const { e, peer } = env();
    const rtc = createCallRtc(e);
    const offer = rtc.offer();
    await vi.waitFor(() => expect(peer.localDescription).not.toBeNull());
    peer.iceGatheringState = 'complete';
    peer.fire('icegatheringstatechange');
    await expect(offer).resolves.toBe('v=0 partial +candidates');
    expect(peer.tracks).toHaveLength(1);
    expect(peer.channel.label).toBe('oai-events');
  });

  it('sends the offer anyway after the ICE wait', async () => {
    vi.useFakeTimers();
    try {
      const { e } = env();
      const offer = createCallRtc(e).offer();
      await vi.advanceTimersByTimeAsync(ICE_WAIT_MS + 10);
      await expect(offer).resolves.toContain('v=0');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a microphone error when the mic is refused, and holds nothing open', async () => {
    const { e, peer } = env({ getMicrophone: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    const err = await createCallRtc(e).offer().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RtcError);
    expect((err as RtcError).code).toBe('microphone');
    expect(peer.closed).toBe(false);
  });

  it('applies the answer, plays the remote audio, and passes data-channel JSON on', async () => {
    const { e, peer } = env();
    const rtc = createCallRtc(e);
    const events: unknown[] = [];
    rtc.onEvent((ev) => events.push(ev));
    peer.iceGatheringState = 'complete';
    await rtc.offer();
    await rtc.answer('v=0 answer');
    expect(peer.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    peer.fire('track', { streams: ['remote-stream'] });
    expect(e.playRemote).toHaveBeenCalledWith('remote-stream');
    peer.channel.fire('message', { data: JSON.stringify({ type: 'session.started' }) });
    peer.channel.fire('message', { data: 'not json' });
    expect(events).toEqual([{ type: 'session.started' }]);
  });

  it('mutes by disabling the mic track', async () => {
    const { e, peer, track } = env();
    const rtc = createCallRtc(e);
    peer.iceGatheringState = 'complete';
    await rtc.offer();
    rtc.setMuted(true);
    expect(track.enabled).toBe(false);
    rtc.setMuted(false);
    expect(track.enabled).toBe(true);
  });

  it('Pause turns the mic off whatever Mute says, and Resume restores Mute', async () => {
    const { e, peer, track } = env();
    const rtc = createCallRtc(e);
    peer.iceGatheringState = 'complete';
    await rtc.offer();
    rtc.setMuted(true);
    rtc.setPaused(true);
    rtc.setPaused(false);
    expect(track.enabled).toBe(false);
    rtc.setMuted(false);
    expect(track.enabled).toBe(true);
    rtc.setPaused(true);
    expect(track.enabled).toBe(false);
  });

  it('reports a dropped connection once', async () => {
    const { e, peer } = env();
    const rtc = createCallRtc(e);
    const dropped = vi.fn();
    rtc.onDropped(dropped);
    peer.iceGatheringState = 'complete';
    await rtc.offer();
    peer.connectionState = 'failed';
    peer.fire('connectionstatechange');
    peer.fire('connectionstatechange');
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('close() stops the mic, the audio, the channel and the peer', async () => {
    const { e, peer, track, stopPlay } = env();
    const rtc = createCallRtc(e);
    peer.iceGatheringState = 'complete';
    await rtc.offer();
    peer.fire('track', { streams: ['s'] });
    rtc.close();
    expect(track.stopped).toBe(true);
    expect(stopPlay).toHaveBeenCalled();
    expect(peer.channel.closed).toBe(true);
    expect(peer.closed).toBe(true);
  });

  it('hanging up while the mic prompt is open lets go of the mic once it is granted', async () => {
    let grant: (s: unknown) => void = () => {};
    const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
    const created = vi.fn();
    const { e } = env({
      getMicrophone: () => new Promise((r) => { grant = r as (s: unknown) => void; }) as never,
      createPeer: () => { created(); return new FakePeer(); },
    });
    const rtc = createCallRtc(e);
    const offer = rtc.offer();
    rtc.close();
    grant({ getAudioTracks: () => [track], getTracks: () => [track] });
    await expect(offer).rejects.toBeInstanceOf(RtcError);
    expect(track.stopped).toBe(true);
    expect(created).not.toHaveBeenCalled();
  });
});

