// inboxAlerts.test.ts — which raised alerts the phone's Inbox lists and its badge counts (Nov 26 2026).
import { describe, it, expect } from 'vitest';
import type { RaisedAlert } from '@/types';
import { DEFAULT_ALERT_CONFIG, type AlertLevel } from '@/lib/attention';
import { shownAlerts } from './inboxAlerts';

const alert = (id: string, sessionId: string, level?: AlertLevel): RaisedAlert => ({
  id, key: id, sessionId, centralId: '', centralSessionId: null, message: `m ${id}`, raisedAt: 1, updatedAt: 1, count: 1,
  ...(level ? { level } : {}),
});

const sessions = new Map([
  ['live', { sessionId: 'live', status: 'working', level: 'normal' as AlertLevel }],
  ['silent', { sessionId: 'silent', status: 'working', level: 'silent' as AlertLevel }],
  ['quiet', { sessionId: 'quiet', status: 'waiting', level: 'quiet' as AlertLevel }],
  ['gone', { sessionId: 'gone', status: 'ended', level: 'normal' as AlertLevel }],
]);
const levelOf = (s: { level: AlertLevel }) => s.level;
const outputsOf = (level: AlertLevel) => DEFAULT_ALERT_CONFIG.levels[level];

describe('shownAlerts', () => {
  it('lists alerts on live sessions whose level shows hints', () => {
    const out = shownAlerts([alert('a', 'live'), alert('b', 'quiet'), alert('c', 'live', 'loud')], sessions, levelOf, outputsOf);
    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out a Silent session’s alert, even one a central asked to be loud', () => {
    expect(shownAlerts([alert('a', 'silent', 'urgent')], sessions, levelOf, outputsOf)).toEqual([]);
  });

  it('leaves out an alert a central asked to be Silent', () => {
    expect(shownAlerts([alert('a', 'live', 'silent')], sessions, levelOf, outputsOf)).toEqual([]);
  });

  it('leaves out alerts on ended or unknown sessions', () => {
    expect(shownAlerts([alert('a', 'gone'), alert('b', 'nowhere')], sessions, levelOf, outputsOf)).toEqual([]);
  });
});
