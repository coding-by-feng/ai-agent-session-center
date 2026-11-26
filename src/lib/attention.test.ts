import { describe, expect, it } from 'vitest';
import {
  ALERT_LEVELS,
  DEFAULT_ALERT_CONFIG,
  alertLevelSummary,
  describeAlertLevel,
  isAlertLevel,
  legacyFlags,
  levelAfterAlert,
  levelAfterMute,
  ownAlertLevel,
  parseAlertConfig,
  readAlertConfigBody,
  resolveAlertLevel,
  roomAlertLevelOf,
} from './attention';

describe('the five levels', () => {
  it('run from Silent to Urgent', () => {
    expect(ALERT_LEVELS).toEqual(['silent', 'quiet', 'normal', 'loud', 'urgent']);
  });

  it('default to what Mute, nothing and Alert did before, with Urgent repeating every 5 min', () => {
    const { levels, defaultLevel } = DEFAULT_ALERT_CONFIG;
    expect(defaultLevel).toBe('normal');
    expect(levels.silent).toEqual({ sound: 'none', notify: 'none', push: false, glow: false, hint: false, repeatMin: 0 });
    expect(levels.quiet).toEqual({ sound: 'none', notify: 'none', push: false, glow: false, hint: true, repeatMin: 0 });
    expect(levels.normal).toEqual({ sound: 'normal', notify: 'proceed', push: true, glow: false, hint: true, repeatMin: 0 });
    expect(levels.loud).toEqual({ sound: 'loud', notify: 'all', push: true, glow: true, hint: true, repeatMin: 0 });
    expect(levels.urgent).toEqual({ sound: 'loud', notify: 'all', push: true, glow: true, hint: true, repeatMin: 5 });
  });

  it('knows a level when it sees one', () => {
    expect(isAlertLevel('loud')).toBe(true);
    expect(isAlertLevel('LOUD')).toBe(false);
    expect(isAlertLevel(undefined)).toBe(false);
    expect(isAlertLevel(3)).toBe(false);
  });
});

describe('a session’s level', () => {
  it('is its own level first', () => {
    expect(ownAlertLevel({ alertLevel: 'quiet' })).toBe('quiet');
    expect(resolveAlertLevel({ alertLevel: 'quiet' }, 'loud', 'normal')).toBe('quiet');
  });

  it('reads the two older switches when it has no level (an older client or snapshot): Alert wins over Mute', () => {
    expect(ownAlertLevel({ muted: true })).toBe('silent');
    expect(ownAlertLevel({ alerted: true })).toBe('loud');
    expect(ownAlertLevel({ alerted: true, muted: true })).toBe('loud');
    expect(ownAlertLevel({ alerted: false, muted: false })).toBeUndefined();
  });

  it('then follows its room, then the default', () => {
    expect(resolveAlertLevel({}, 'loud', 'normal')).toBe('loud');
    expect(resolveAlertLevel({}, undefined, 'quiet')).toBe('quiet');
    expect(resolveAlertLevel({ muted: false }, null, 'normal')).toBe('normal');
  });

  it('ignores a level it does not know, wherever it comes from', () => {
    expect(resolveAlertLevel({ alertLevel: 'deafening' as never }, 'bogus' as never, 'normal')).toBe('normal');
  });

  it('says where the level came from, for the picker', () => {
    expect(describeAlertLevel({ alertLevel: 'loud' }, 'quiet', 'normal')).toEqual({ level: 'loud', source: 'session' });
    expect(describeAlertLevel({}, 'quiet', 'normal')).toEqual({ level: 'quiet', source: 'room' });
    expect(describeAlertLevel({}, undefined, 'normal')).toEqual({ level: 'normal', source: 'default' });
  });

  it('finds the room level of the room that holds the session', () => {
    const rooms = [
      { sessionIds: ['a'], alertLevel: 'urgent' as const },
      { sessionIds: ['b'] },
    ];
    expect(roomAlertLevelOf('a', rooms)).toBe('urgent');
    expect(roomAlertLevelOf('b', rooms)).toBeUndefined();
    expect(roomAlertLevelOf('c', rooms)).toBeUndefined();
  });
});

describe('the older Mute and Alert switches', () => {
  it('mirror a level: Silent is muted, Loud and Urgent are alerted', () => {
    expect(legacyFlags('silent')).toEqual({ muted: true, alerted: false });
    expect(legacyFlags('quiet')).toEqual({ muted: false, alerted: false });
    expect(legacyFlags('normal')).toEqual({ muted: false, alerted: false });
    expect(legacyFlags('loud')).toEqual({ muted: false, alerted: true });
    expect(legacyFlags('urgent')).toEqual({ muted: false, alerted: true });
    expect(legacyFlags(null)).toEqual({ muted: false, alerted: false });
  });

  it('map Mute onto a level: on is Silent; off lets the session follow its room, unless that is Silent too', () => {
    expect(levelAfterMute('normal', 'normal', true)).toBe('silent');
    expect(levelAfterMute(undefined, 'normal', true)).toBe('silent');
    expect(levelAfterMute('silent', 'normal', false)).toBeNull();
    expect(levelAfterMute('silent', 'silent', false)).toBe('normal');
    expect(levelAfterMute(undefined, 'silent', false)).toBe('normal');
    expect(levelAfterMute('loud', 'normal', false)).toBeUndefined();
  });

  it('map Alert onto a level: on is Loud (Urgent stays Urgent); off lets the session follow its room, unless that is loud too', () => {
    expect(levelAfterAlert('normal', 'normal', true)).toBe('loud');
    expect(levelAfterAlert('urgent', 'normal', true)).toBeUndefined();
    expect(levelAfterAlert('loud', 'normal', false)).toBeNull();
    expect(levelAfterAlert('urgent', 'quiet', false)).toBeNull();
    expect(levelAfterAlert('loud', 'loud', false)).toBe('normal');
    expect(levelAfterAlert(undefined, 'urgent', false)).toBe('normal');
    expect(levelAfterAlert('silent', 'normal', false)).toBeUndefined();
  });
});

describe('the level table', () => {
  it('fills anything missing or wrong in a saved table from the defaults', () => {
    const cfg = parseAlertConfig({
      defaultLevel: 'quiet',
      levels: { loud: { sound: 'normal', repeatMin: 'often' }, urgent: 'nope' },
    });
    expect(cfg.defaultLevel).toBe('quiet');
    expect(cfg.levels.loud).toEqual({ ...DEFAULT_ALERT_CONFIG.levels.loud, sound: 'normal' });
    expect(cfg.levels.urgent).toEqual(DEFAULT_ALERT_CONFIG.levels.urgent);
    expect(parseAlertConfig(null)).toEqual(DEFAULT_ALERT_CONFIG);
    expect(parseAlertConfig({ defaultLevel: 'deafening' }).defaultLevel).toBe('normal');
  });

  it('keeps Silent silent whatever was saved for it', () => {
    const cfg = parseAlertConfig({ levels: { silent: { sound: 'loud', notify: 'all', push: true, glow: true, hint: true, repeatMin: 5 } } });
    expect(cfg.levels.silent).toEqual(DEFAULT_ALERT_CONFIG.levels.silent);
  });

  it('takes a whole table from a request, or nothing', () => {
    const good = { ...DEFAULT_ALERT_CONFIG, levels: { ...DEFAULT_ALERT_CONFIG.levels, normal: { ...DEFAULT_ALERT_CONFIG.levels.normal, repeatMin: 10 } } };
    expect(readAlertConfigBody(good)?.levels.normal.repeatMin).toBe(10);
    expect(readAlertConfigBody({ ...good, defaultLevel: 'deafening' })).toBeNull();
    expect(readAlertConfigBody({ ...good, levels: { ...good.levels, loud: { ...good.levels.loud, repeatMin: 61 } } })).toBeNull();
    expect(readAlertConfigBody({ ...good, levels: { ...good.levels, quiet: undefined } })).toBeNull();
    expect(readAlertConfigBody('table')).toBeNull();
  });

  it('a request cannot make Silent make a sound', () => {
    const body = { ...DEFAULT_ALERT_CONFIG, levels: { ...DEFAULT_ALERT_CONFIG.levels, silent: { ...DEFAULT_ALERT_CONFIG.levels.loud } } };
    expect(readAlertConfigBody(body)?.levels.silent).toEqual(DEFAULT_ALERT_CONFIG.levels.silent);
  });

  it('sums a level up in a few words, for the picker', () => {
    const { levels } = DEFAULT_ALERT_CONFIG;
    expect(alertLevelSummary(levels.silent)).toBe('No sound, notification or push');
    expect(alertLevelSummary(levels.quiet)).toBe('No sound, notification or push');
    expect(alertLevelSummary(levels.normal)).toBe('Sounds · notification for proceed asks · phone push');
    expect(alertLevelSummary(levels.loud)).toBe('Loud sound · notification · phone push · glowing card');
    expect(alertLevelSummary(levels.urgent)).toBe('Loud sound · notification · phone push · glowing card · again every 5 min');
  });
});
