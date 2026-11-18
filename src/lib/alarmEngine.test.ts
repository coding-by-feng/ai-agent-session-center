/**
 * Alert (the bell in the control bar) must be loud and obvious for approval and completion
 * (Nov 18 2026). Before: a 2.5x boost of the normal sound, restored before a sequence's notes
 * fired, and only for a session toggled in this window since it loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./soundEngine', () => ({
  soundEngine: {
    play: vi.fn(() => true),
    preview: vi.fn(),
    playLoud: vi.fn(),
    setVolume: vi.fn(),
    getVolume: vi.fn(() => 0.5),
  },
}));
vi.mock('./cliDetect', () => ({ detectCli: () => null }));

import { soundEngine } from './soundEngine';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  checkAlarms, clearAllAlarms, handleEventSounds, alertSession, unalertSession, muteSession, unmuteSession,
} from './alarmEngine';
import type { Session } from '@/types';

const engine = vi.mocked(soundEngine);

const makeSession = (over: Partial<Session> = {}): Session => ({
  sessionId: 's1', status: 'working', events: [], startedAt: 0, lastActivityAt: 0,
  ...over,
} as unknown as Session);

const stop = (timestamp: number) => ({ type: 'Stop', timestamp, detail: '' });

describe('alarmEngine — Alert', () => {
  const baseSound = useSettingsStore.getState().soundSettings;
  let sessions: Map<string, Session>;
  const getSessions = () => sessions;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessions = new Map();
    useSettingsStore.setState({ soundSettings: { ...baseSound, enabled: true, perCli: {} } } as never);
  });
  afterEach(() => {
    clearAllAlarms();
    unalertSession('s1');
    unmuteSession('s1');
    useSettingsStore.setState({ soundSettings: baseSound } as never);
    vi.useRealTimers();
  });

  it('sounds the siren, loud, when an alerted session needs approval, and again every 5 s', () => {
    const s = makeSession({ status: 'approval', alerted: true });
    sessions.set('s1', s);

    checkAlarms(s, getSessions);
    expect(engine.playLoud).toHaveBeenCalledWith('siren');
    expect(engine.play).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(engine.playLoud).toHaveBeenCalledTimes(2);
  });

  it('rings the bells, loud, once for each completion of an alerted session', () => {
    const s = makeSession({ alerted: true, status: 'waiting', events: [stop(100)] as never });

    handleEventSounds(s, makeSession({ alerted: true }));
    expect(engine.playLoud).toHaveBeenCalledWith('bells');

    // A later update that still ends on the same Stop (a status decay, a title) is silent.
    handleEventSounds({ ...s, status: 'idle' } as Session, s);
    expect(engine.playLoud).toHaveBeenCalledTimes(1);

    // The next turn's Stop rings again.
    handleEventSounds({ ...s, events: [stop(100), stop(200)] } as never, s);
    expect(engine.playLoud).toHaveBeenCalledTimes(2);
  });

  it('reads Alert from the session, so it works after a reload or from another device', () => {
    const s = makeSession({ status: 'approval', alerted: true });
    sessions.set('s1', s);
    checkAlarms(s, getSessions); // this window never clicked the bell
    expect(engine.playLoud).toHaveBeenCalledWith('siren');
  });

  it('the session saying Alert is off wins over an old click in this window', () => {
    alertSession('s1');
    const s = makeSession({ status: 'approval', alerted: false });
    sessions.set('s1', s);
    checkAlarms(s, getSessions);
    expect(engine.playLoud).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledWith('approvalNeeded');
  });

  it('a click in this window counts until the session carries the flag', () => {
    alertSession('s1');
    const s = makeSession({ status: 'approval' });
    sessions.set('s1', s);
    checkAlarms(s, getSessions);
    expect(engine.playLoud).toHaveBeenCalledWith('siren');
  });

  it('is heard even when the session is muted or sounds are off', () => {
    useSettingsStore.setState({ soundSettings: { ...baseSound, enabled: false, muteApproval: true, perCli: {} } } as never);
    const s = makeSession({ status: 'approval', alerted: true, muted: true });
    sessions.set('s1', s);
    checkAlarms(s, getSessions);
    expect(engine.playLoud).toHaveBeenCalledWith('siren');

    handleEventSounds(makeSession({ alerted: true, muted: true, events: [stop(5)] as never }));
    expect(engine.playLoud).toHaveBeenCalledWith('bells');
  });

  it('plays the other events of an alerted session normally, with no volume games', () => {
    handleEventSounds(makeSession({ alerted: true, events: [{ type: 'UserPromptSubmit', timestamp: 1, detail: '' }] as never }));
    expect(engine.play).toHaveBeenCalledWith('promptSubmit');
    expect(engine.playLoud).not.toHaveBeenCalled();
    expect(engine.setVolume).not.toHaveBeenCalled();
  });

  it('stops the siren once the approval is answered', () => {
    const s = makeSession({ status: 'approval', alerted: true });
    sessions.set('s1', s);
    checkAlarms(s, getSessions);
    const answered = { ...s, status: 'working' } as Session;
    sessions.set('s1', answered);
    checkAlarms(answered, getSessions);
    vi.advanceTimersByTime(20_000);
    expect(engine.playLoud).toHaveBeenCalledTimes(1);
  });
});

describe('alarmEngine — sessions without Alert', () => {
  const baseSound = useSettingsStore.getState().soundSettings;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useSettingsStore.setState({ soundSettings: { ...baseSound, enabled: true, perCli: {} } } as never);
  });
  afterEach(() => {
    clearAllAlarms();
    unmuteSession('s1');
    useSettingsStore.setState({ soundSettings: baseSound } as never);
    vi.useRealTimers();
  });

  it('plays the normal completion sound once per Stop', () => {
    const s = makeSession({ events: [stop(100)] as never });
    handleEventSounds(s, makeSession());
    handleEventSounds({ ...s, status: 'idle' } as Session, s);
    expect(engine.play).toHaveBeenCalledTimes(1);
    expect(engine.play).toHaveBeenCalledWith('taskComplete');
  });

  it('a muted session stays quiet, whether muted here or on the session', () => {
    muteSession('s1');
    handleEventSounds(makeSession({ events: [stop(1)] as never }));
    unmuteSession('s1');
    handleEventSounds(makeSession({ muted: true, events: [stop(2)] as never }));
    expect(engine.play).not.toHaveBeenCalled();
  });
});
