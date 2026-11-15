// callScreen.ts — the voice call screen (Nov 15 2026): who you are talking to, the call's state and clock, the live
// transcript, Mute and End call. The remote audio plays from an element outside this screen, so redrawing it every
// second does not interrupt the sound. Each button has an id, so a redraw keeps focus on it (app.ts render).
import type { SavedMac } from '../savedMacs.js';
import { formatDuration } from '../voiceCall.js';
import { h } from './dom.js';
import { actions, alert, button, para, screen, status } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type CallScreen = Extract<Screen, { name: 'call' }>;

function transcript(s: CallScreen): HTMLElement | null {
  if (s.lines.length === 0) return null;
  return h('ol', { class: 'call-transcript', attrs: { 'aria-label': 'Transcript', 'aria-live': 'polite' } },
    ...s.lines.map((l) => h('li', { class: `call-line call-${l.role}` },
      h('span', { class: 'call-who' }, l.role === 'you' ? 'You' : 'AASC'),
      h('span', { class: 'call-text' }, l.text.trim()))));
}

export function renderCall(s: CallScreen, mac: SavedMac, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  if (s.phase === 'failed' || s.phase === 'ended') {
    return screen(s.phase === 'failed' ? 'Call didn’t work' : 'Call ended', null,
      alert(s.phase === 'failed' ? s.message : null),
      s.phase === 'ended' && s.message ? para(s.message) : null,
      transcript(s),
      actions(
        button('Call again', a.retryCall, 'primary', { id: 'call-retry' }),
        button(`Back to ${mac.name}`, a.endCall, 'secondary', { id: 'call-back' })));
  }

  const line = s.phase === 'starting'
    ? status(`Calling AASC on ${mac.name}…`, true)
    // Not a live region: it changes every second, and a screen reader would read each tick.
    : h('p', { class: 'status call-clock' }, `${s.muted ? 'Muted' : 'Live'} · ${formatDuration(s.now - (s.startedAt ?? s.now))}`);

  return screen('Call with AASC', null,
    line,
    s.phase === 'live' && s.lines.length === 0 ? para('Talk now. Ask about your sessions, or ask AASC to start one.', 'hint') : null,
    transcript(s),
    actions(
      button('End call', a.endCall, 'danger', { id: 'call-end' }),
      s.phase === 'live'
        ? button(s.muted ? 'Unmute' : 'Mute', a.toggleMute, 'secondary', { id: 'call-mute', 'aria-pressed': s.muted ? 'true' : 'false' })
        : null));
}
