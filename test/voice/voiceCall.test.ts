import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startVoiceCall, type VoiceCallDeps } from '../../server/voice/voiceCall.js';
import { QUIET_MS } from '../../server/voice/turnGate.js';
import type { Sideband, LiveEvent } from '../../server/voice/liveApi.js';
import type { DigestSession } from '../../server/voice/digest.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

class FakeSideband implements Sideband {
  sent: LiveEvent[] = [];
  closed = false;
  ready = Promise.resolve();
  private events = new Set<(e: LiveEvent) => void>();
  private closes = new Set<() => void>();
  send(e: LiveEvent): void { this.sent.push(e); }
  onEvent(l: (e: LiveEvent) => void): () => void { this.events.add(l); return () => this.events.delete(l); }
  onClose(l: () => void): () => void { this.closes.add(l); return () => this.closes.delete(l); }
  close(): void { if (this.closed) return; this.closed = true; for (const l of [...this.closes]) l(); }
  emit(e: LiveEvent): void { for (const l of [...this.events]) l(e); }
  ofType(type: string): LiveEvent[] { return this.sent.filter((e) => e.type === type); }
}

const sess = (id: string, status: string, title = id): DigestSession => ({
  sessionId: id, title, status, lastActivityAt: Date.now(), isCentral: false,
});

describe('startVoiceCall', () => {
  let sb: FakeSideband;
  let sessions: DigestSession[];
  let changed: (() => void) | null;
  let ask: ReturnType<typeof vi.fn>;
  let deps: VoiceCallDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    sb = new FakeSideband();
    sessions = [sess('a', 'working', 'Codex review')];
    changed = null;
    ask = vi.fn(async () => 'There are **two** sessions.');
    deps = {
      sideband: sb,
      brain: { ask },
      isLocal: true,
      sessions: () => sessions,
      onSessionsChanged: (l) => { changed = l; return () => { changed = null; }; },
    };
  });
  afterEach(() => vi.useRealTimers());

  /** The line the n-th question would type (its compose function, with a sample tag). */
  const asked = (n: number): string => (ask.mock.calls[n][0] as (tag: string) => string)('q1');

  it('gives the voice the AASC status as silent context once attached', async () => {
    startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    const thinking = sb.ofType('session.thinking.append');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ delegation_id: null });
    expect(String(thinking[0].content)).toContain('Codex review');
    expect(typeof thinking[0].event_id).toBe('string');
  });

  it('turns a delegation into a question for the brain and speaks the answer for that delegation', async () => {
    startVoiceCall(deps);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'What is running?', start_ms: 1000, end_ms: 1800 });
    sb.emit({ type: 'session.delegation.created', event_id: 'e1', offset_ms: 1900, delegation: { id: 'd1', type: 'delegation', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(asked(0)).toContain('"What is running?"');
    await vi.advanceTimersByTimeAsync(QUIET_MS); // the answer waits until the person has been quiet (turnGate.ts)
    const said = sb.ofType('session.commentary.append');
    expect(said).toEqual([expect.objectContaining({ delegation_id: 'd1', content: 'There are two sessions.' })]);
  });

  it('asks the briefing for the person’s words and types it with the question (Nov 22 2026)', async () => {
    const briefing = vi.fn((request: string) => `Skills that fit this request: /concept-to-diagram for ${request}`);
    startVoiceCall({ ...deps, briefing });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'make a concept diagram', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(briefing).toHaveBeenCalledWith('make a concept diagram');
    expect(asked(0)).toContain('/concept-to-diagram for make a concept diagram');
  });

  // Nov 24 2026: what the person adds on the call screen waits for their next question.
  it('takes what was added on the call screen to the next question only, and tells the voice it is there', async () => {
    const call = startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    const photo = call.attach({ kind: 'photo', name: 'receipt.jpg', path: '/tmp/claude-queue-images/queue-img-1-abc.jpg' });
    const skill = call.attach({ kind: 'skill', name: '/expense-log' });
    expect(photo).not.toBeNull();
    expect(call.pending().map((a) => a.name)).toEqual(['receipt.jpg', '/expense-log']);
    expect(call.detach(skill!.id)).toBe(true);
    // The voice can't see it, but knows to hand it over with the next request.
    const note = sb.ofType('session.thinking.append').map((e) => String(e.content)).find((c) => c.includes('receipt.jpg'));
    expect(note).toMatch(/next request/);
    expect(ask).not.toHaveBeenCalled(); // nothing goes to the central on its own

    sb.emit({ type: 'session.input_transcript.delta', delta: 'what is on this receipt', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked(0)).toContain('photo receipt.jpg at /tmp/claude-queue-images/queue-img-1-abc.jpg');
    expect(asked(0)).not.toContain('/expense-log');
    expect(call.pending()).toEqual([]);

    sb.emit({ type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 2000, end_ms: 2500 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 2600, delegation: { id: 'd2', target: 'client' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked(1)).not.toContain('receipt.jpg');
  });

  it('keeps what was added for the next question when the central never got this one', async () => {
    ask.mockRejectedValueOnce(new Error('not_running'));
    const call = startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    call.attach({ kind: 'photo', name: 'receipt.jpg', path: '/tmp/claude-queue-images/queue-img-1-abc.jpg' });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'what is on this receipt', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked(0)).toContain('receipt.jpg');
    expect(call.pending().map((a) => a.name)).toEqual(['receipt.jpg']);
  });

  it('deletes the files still waiting when the call ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-call-end-'));
    try {
      const file = join(dir, 'queue-img-1-abc.jpg');
      writeFileSync(file, 'x');
      const call = startVoiceCall(deps);
      await vi.advanceTimersByTimeAsync(0);
      call.attach({ kind: 'photo', name: 'receipt.jpg', path: file });
      sb.close();
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds nothing once the call has ended', () => {
    const call = startVoiceCall(deps);
    sb.close();
    expect(call.attach({ kind: 'skill', name: '/x' })).toBeNull();
  });

  it('keeps each reply word for word, and when the question in progress was handed over (Nov 22 2026)', async () => {
    let answer: (text: string) => void = () => undefined;
    ask.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
    vi.setSystemTime(10_000);
    const call = startVoiceCall({ ...deps, now: Date.now });
    expect(call.busySince()).toBeNull();
    sb.emit({ type: 'session.input_transcript.delta', delta: 'what is new', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.busySince()).toBe(10_600);
    answer('v2.10.80 adds **phone dictation**.');
    await vi.advanceTimersByTimeAsync(0);
    expect(call.busySince()).toBeNull();
    expect(call.replies()).toEqual([{ at: 11_000, text: 'v2.10.80 adds **phone dictation**.' }]);
  });

  it('says only the spoken part; the on-screen part goes to the replies for the call screen (Nov 23 2026)', async () => {
    ask.mockResolvedValue('It found two changes.\n[[screen]]\n| Change | Words |\n| --- | --- |\n| Cover | 6 |');
    vi.setSystemTime(10_000);
    const call = startVoiceCall({ ...deps, now: Date.now });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'what changed', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000 + QUIET_MS);
    const said = sb.ofType('session.commentary.append').map((e) => e.content);
    expect(said).toEqual(['It found two changes.']);
    expect(call.replies()).toEqual([{ at: expect.any(Number), text: 'It found two changes.', screen: '| Change | Words |\n| --- | --- |\n| Cover | 6 |' }]);
  });

  it('keeps no reply for a failed question', async () => {
    ask.mockRejectedValue(new Error('boom'));
    const call = startVoiceCall(deps);
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.replies()).toEqual([]);
    expect(call.busySince()).toBeNull();
  });

  it('still asks when the briefing fails', async () => {
    startVoiceCall({ ...deps, briefing: () => { throw new Error('catalog unreadable'); } });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'what is running', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked(0)).toContain('"what is running"');
  });

  it('asks about only what was said since the previous delegation', async () => {
    startVoiceCall(deps);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'check the project', start_ms: 0, end_ms: 900 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'now start a Codex review', start_ms: 5000, end_ms: 6000 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 6100, delegation: { id: 'd2', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked(1)).toContain('"now start a Codex review"');
    expect(asked(1)).not.toContain('"check the project');
  });

  it('ignores a delegation for another target', async () => {
    startVoiceCall(deps);
    sb.emit({ type: 'session.delegation.created', offset_ms: 1, delegation: { id: 'd1', target: 'responses' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ask).not.toHaveBeenCalled();
  });

  it('says what went wrong when the brain fails, for that delegation', async () => {
    ask.mockRejectedValueOnce(Object.assign(new Error('x'), { spoken: 'The Voice central is not running.' }));
    startVoiceCall(deps);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 200, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(QUIET_MS); // the answer waits until the person has been quiet (turnGate.ts)
    expect(sb.ofType('session.commentary.append')[0]).toMatchObject({ delegation_id: 'd1', content: 'The Voice central is not running.' });
  });

  it('announces a session that finishes during the call, and refreshes the silent status', async () => {
    startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    sessions = [sess('a', 'waiting', 'Codex review')];
    changed?.();
    await vi.advanceTimersByTimeAsync(5000);
    const said = sb.ofType('session.commentary.append');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ delegation_id: null });
    expect(String(said[0].content)).toContain('Codex review');
    expect(String(said[0].content)).toMatch(/finished/);
    expect(sb.ofType('session.thinking.append').length).toBe(2);
  });

  describe('results, not just "finished" (Nov 23 2026)', () => {
    it('asks the Voice central what a session this call gave work to found, and says it after the status line', async () => {
      ask.mockImplementation(async () => 'Codex review fixed the **login redirect** and all 42 tests pass.');
      startVoiceCall({ ...deps, touched: () => new Map([['a', 'T7']]) });
      await vi.advanceTimersByTimeAsync(0);
      sessions = [sess('a', 'waiting', 'Codex review')];
      changed?.();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ask).toHaveBeenCalledTimes(1);
      const line = asked(0);
      expect(line).toContain('[AASC · voice q1]');
      expect(line).toContain('"Codex review" (task T7: task_get has its answer) just finished');
      expect(line).toContain('Do not start new work');
      const said = sb.ofType('session.commentary.append').map((e) => e.content);
      expect(said).toEqual([
        'AASC update: "Codex review" has finished.',
        'Codex review fixed the login redirect and all 42 tests pass.',
      ]);
    });

    it('only names a session the call did not touch: no Voice-central turn for it', async () => {
      startVoiceCall({ ...deps, touched: () => new Map([['other', null]]) });
      await vi.advanceTimersByTimeAsync(0);
      sessions = [sess('a', 'waiting', 'Codex review')];
      changed?.();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ask).not.toHaveBeenCalled();
      expect(sb.ofType('session.commentary.append')).toHaveLength(1);
    });

    it('a failed summary costs only the summary: the status line was said', async () => {
      ask.mockImplementation(async () => { throw new Error('central gone'); });
      startVoiceCall({ ...deps, touched: () => new Map([['a', null]]) });
      await vi.advanceTimersByTimeAsync(0);
      sessions = [sess('a', 'waiting', 'Codex review')];
      changed?.();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sb.ofType('session.commentary.append').map((e) => e.content)).toEqual(['AASC update: "Codex review" has finished.']);
    });

    it('says a note AASC sends (a confirmed setting), held while the person talks, and stops listening at the end', async () => {
      let note: ((text: string) => void) | null = null;
      const call = startVoiceCall({ ...deps, onNote: (l) => { note = l; return () => { note = null; }; } });
      await vi.advanceTimersByTimeAsync(0);
      sb.emit({ type: 'session.input_transcript.delta', delta: 'and then', start_ms: 0, end_ms: 1 });
      note!('AASC update: your central now runs on low effort; the CLI confirmed it.');
      expect(sb.ofType('session.commentary.append')).toEqual([]);
      await vi.advanceTimersByTimeAsync(QUIET_MS);
      expect(sb.ofType('session.commentary.append')).toEqual([
        expect.objectContaining({ delegation_id: null, content: 'AASC update: your central now runs on low effort; the CLI confirmed it.' }),
      ]);
      call.end();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(note).toBeNull();
    });
  });

  describe('turn-taking (Nov 22 2026): no spoken update over the person', () => {
    const talk = (delta: string) => sb.emit({ type: 'session.input_transcript.delta', delta, start_ms: 0, end_ms: 1 });

    it('holds "X finished" while the person explains a new request, through a short pause, then says it once', async () => {
      startVoiceCall(deps);
      await vi.advanceTimersByTimeAsync(0);
      talk('can you open a new session for the web');
      sessions = [sess('a', 'waiting', 'Codex review')];
      changed?.();
      await vi.advanceTimersByTimeAsync(2_000); // the change is announced 2 s later, mid-sentence
      expect(sb.ofType('session.commentary.append')).toEqual([]);
      expect(sb.ofType('session.thinking.append')).toHaveLength(2); // the silent status still goes at once
      talk('site and run the tests'); // after a short hesitation: the same turn
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sb.ofType('session.commentary.append')).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      const said = sb.ofType('session.commentary.append');
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ delegation_id: null, content: 'AASC update: "Codex review" has finished.' });
    });

    it('holds an earlier question’s answer while the person is on the next one', async () => {
      let answer: (text: string) => void = () => undefined;
      ask.mockImplementation(() => new Promise<string>((r) => { answer = r; }));
      startVoiceCall(deps);
      talk('what is running');
      sb.emit({ type: 'session.delegation.created', offset_ms: 1000, delegation: { id: 'd1', target: 'client' } });
      await vi.advanceTimersByTimeAsync(5_000);
      talk('and after that start a review of');
      answer('Two sessions are running.');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sb.ofType('session.commentary.append')).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sb.ofType('session.commentary.append')).toEqual([
        expect.objectContaining({ delegation_id: 'd1', content: 'Two sessions are running.' }),
      ]);
    });

    it('drops what it held when the call ends', async () => {
      startVoiceCall(deps);
      await vi.advanceTimersByTimeAsync(0);
      talk('hello');
      sessions = [sess('a', 'waiting', 'Codex review')];
      changed?.();
      await vi.advanceTimersByTimeAsync(2_100);
      sb.emit({ type: 'session.closed', reason: 'remote_hangup' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sb.ofType('session.commentary.append')).toEqual([]);
    });
  });

  it('does not resend an unchanged status', async () => {
    startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    changed?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sb.ofType('session.thinking.append')).toHaveLength(1);
  });

  it('ends when the session closes, and stops listening for session changes', async () => {
    const call = startVoiceCall(deps);
    const ended = vi.fn();
    call.onEnded(ended);
    sb.emit({ type: 'session.closed', reason: 'remote_hangup' });
    expect(ended).toHaveBeenCalledWith('remote_hangup');
    expect(changed).toBeNull();
    expect(call.isActive()).toBe(false);
  });

  it('end() asks OpenAI to close, then drops the socket if no answer comes', async () => {
    const call = startVoiceCall(deps);
    call.end();
    expect(sb.ofType('session.close')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sb.closed).toBe(true);
    expect(call.isActive()).toBe(false);
  });

  it('hangs up after the idle limit with nothing said', async () => {
    const call = startVoiceCall({ ...deps, idleMs: 60_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'still here', start_ms: 1, end_ms: 2 });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(call.isActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sb.ofType('session.close')).toHaveLength(1);
  });

  it('keeps the transcript for the screen', () => {
    const call = startVoiceCall(deps);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 1, end_ms: 2 });
    sb.emit({ type: 'session.output_transcript.delta', delta: 'hi there', start_ms: 3, end_ms: 4 });
    expect(call.transcript().map((l) => [l.role, l.text])).toEqual([['user', 'hello'], ['assistant', 'hi there']]);
  });

  it('tags the typed line and passes who is calling', async () => {
    startVoiceCall({ ...deps, isLocal: false });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 200, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked(0)).toMatch(/^\[AASC · voice q1\] /);
    expect(ask.mock.calls[0][1]).toMatchObject({ isLocal: false, signal: expect.any(AbortSignal) });
  });

  it('ending the call cancels the questions it handed the brain', async () => {
    const call = startVoiceCall(deps);
    sb.emit({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 });
    sb.emit({ type: 'session.delegation.created', offset_ms: 200, delegation: { id: 'd1', target: 'client' } });
    await vi.advanceTimersByTimeAsync(1000);
    const signal = ask.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    sb.emit({ type: 'session.closed', reason: 'remote_hangup' });
    expect(call.isActive()).toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it('a remote call over its per-minute budget is told to wait, without asking the brain', async () => {
    startVoiceCall({ ...deps, isLocal: false, asksPerMinute: 1 });
    for (const [i, id] of ['d1', 'd2'].entries()) {
      sb.emit({ type: 'session.input_transcript.delta', delta: `q${i}`, start_ms: i * 1000, end_ms: i * 1000 + 100 });
      sb.emit({ type: 'session.delegation.created', offset_ms: i * 1000 + 200, delegation: { id, target: 'client' } });
    }
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(QUIET_MS); // the answer waits until the person has been quiet (turnGate.ts)
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sb.ofType('session.commentary.append')[1]).toMatchObject({ delegation_id: 'd2', content: expect.stringMatching(/wait a moment/i) });
  });

  it('announces changes at least every few seconds, even while updates keep coming', async () => {
    startVoiceCall(deps);
    await vi.advanceTimersByTimeAsync(0);
    sessions = [sess('a', 'waiting', 'Codex review')];
    for (let i = 0; i < 12; i += 1) {
      changed?.();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sb.ofType('session.commentary.append')).toHaveLength(1);
  });

  it('attaches again when the sideband drops, and handles a replayed event once', async () => {
    const second = new FakeSideband();
    const reattach = vi.fn(() => second);
    const call = startVoiceCall({ ...deps, reattach, reattachDelaysMs: [100] });
    sb.emit({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 });
    const delegation = { type: 'session.delegation.created', event_id: 'e7', offset_ms: 200, delegation: { id: 'd1', target: 'client' } };
    sb.emit(delegation);
    sb.close();
    expect(call.isActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(reattach).toHaveBeenCalledTimes(1);
    second.emit(delegation);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(QUIET_MS); // the answer waits until the person has been quiet (turnGate.ts)
    expect(ask).toHaveBeenCalledTimes(1);
    expect(second.ofType('session.commentary.append')).toHaveLength(1);
    expect(second.ofType('session.thinking.append')).toHaveLength(1);
  });

  it('gives up after the last re-attach fails', async () => {
    const dead = (): FakeSideband => { const f = new FakeSideband(); f.ready = Promise.reject(new Error('no')); f.ready.catch(() => {}); queueMicrotask(() => f.close()); return f; };
    const call = startVoiceCall({ ...deps, reattach: dead, reattachDelaysMs: [10, 10] });
    const ended = vi.fn();
    call.onEnded(ended);
    sb.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toHaveBeenCalledWith('connection_lost');
  });
});
