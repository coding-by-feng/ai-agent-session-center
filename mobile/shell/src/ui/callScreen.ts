// callScreen.ts — the voice call screen (Nov 15 2026): who you are talking to, the call's state and clock, the live
// transcript, Mute and End call. Since Nov 22 2026 also the Voice central's panel (its state, current step, time on
// this question, the sessions it handed work to) above the transcript, one line of it in the compact bar, and its
// own replies in the transcript as "Central" lines. The remote audio plays from an element outside this screen, so redrawing it every
// second does not interrupt the sound. Each button has an id, so a redraw keeps focus on it (app.ts render).
import type { SavedMac } from '../savedMacs.js';
import { formatDuration, type CentralState, type TaskState } from '../voiceCall.js';
import { h } from './dom.js';
import { actions, alert, button, para, screen, status } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type CallScreen = Extract<Screen, { name: 'call' }>;

const WHO: Record<CallScreen['lines'][number]['role'], string> = { you: 'You', aasc: 'AASC', central: 'Central' };

const CENTRAL_WORDS: Record<CentralState, string> = { working: 'Working', needs_you: 'Needs you', idle: 'Idle', offline: 'Offline' };

const TASK_WORDS: Record<TaskState, string> = {
  working: 'Working', needs_you: 'Needs you', stalled: 'Stalled', finished: 'Finished', failed: 'Failed', cancelled: 'Cancelled',
};

function transcript(s: CallScreen): HTMLElement | null {
  if (s.lines.length === 0) return null;
  return h('ol', { class: 'call-transcript', attrs: { 'aria-label': 'Transcript', 'aria-live': 'polite' } },
    ...s.lines.map((l) => h('li', { class: `call-line call-${l.role}` },
      h('span', { class: 'call-who' }, WHO[l.role]),
      h('span', { class: 'call-text' }, l.text.trim()))));
}

/** "Working · 0:52": the clock only while it is on this call's question. */
function centralStateLine(s: CallScreen): string {
  const c = s.central;
  if (!c) return '';
  const busy = c.since !== null && (c.state === 'working' || c.state === 'needs_you');
  return busy ? `${CENTRAL_WORDS[c.state]} · ${formatDuration(s.now - (c.since ?? s.now))}` : CENTRAL_WORDS[c.state];
}

/** The Voice central's panel. Not a live region: its clock changes every second. */
function centralPanel(s: CallScreen): HTMLElement | null {
  const c = s.central;
  if (!c) return null;
  return h('section', { class: 'call-progress', attrs: { 'aria-label': 'Voice central', 'data-state': c.state } },
    h('p', { class: 'call-central-head' },
      h('span', { class: 'call-central-name' }, c.title),
      ' ',
      h('span', { class: 'call-central-state' }, centralStateLine(s))),
    c.step ? h('p', { class: 'call-central-step' }, c.step) : null,
    s.tasks.length > 0 ? h('p', { class: 'call-tasks-head' }, 'Handed off this call') : null,
    s.tasks.length > 0
      ? h('ul', { class: 'call-tasks' },
        ...s.tasks.map((t) => h('li', { class: 'call-task' },
          h('span', { class: 'call-task-title' }, t.title),
          ' ',
          h('span', { class: 'call-task-state', attrs: { 'data-state': t.state } }, TASK_WORDS[t.state]))))
      : null);
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

  const state = s.paused ? 'Paused' : s.muted ? 'Muted' : 'Live';
  const clock = `${state} · ${formatDuration(s.now - (s.startedAt ?? s.now))}`;
  const live = s.phase === 'live';

  if (s.minimized) {
    // The compact bar: the clock and the three controls. Not a live region, like the clock line below.
    return h('main', { class: 'screen call-mini' },
      h('p', { class: 'status call-clock', attrs: { id: 'screen-title', tabindex: -1 } }, live ? clock : `Calling AASC on ${mac.name}…`),
      s.central
        ? h('p', { class: 'call-mini-central', attrs: { 'data-state': s.central.state } }, `Central: ${s.central.step ?? CENTRAL_WORDS[s.central.state]}`)
        : null,
      h('div', { class: 'call-mini-actions' },
        live ? button(s.paused ? 'Resume' : 'Pause', a.togglePause, 'secondary', { id: 'call-pause', 'aria-pressed': s.paused ? 'true' : 'false' }) : null,
        live ? button(s.muted ? 'Unmute' : 'Mute', a.toggleMute, 'secondary', { id: 'call-mute', 'aria-pressed': s.muted ? 'true' : 'false' }) : null,
        button('End call', a.endCall, 'danger', { id: 'call-end' }),
        button('Expand', a.toggleMinimize, 'quiet', { id: 'call-expand' })));
  }

  const line = s.phase === 'starting'
    ? status(`Calling AASC on ${mac.name}…`, true)
    // Not a live region: it changes every second, and a screen reader would read each tick.
    : h('p', { class: 'status call-clock' }, clock);

  return screen('Call with AASC', null,
    line,
    centralPanel(s),
    s.phase === 'live' && s.lines.length === 0 ? para('Talk now. Ask about your sessions, or ask AASC to start one.', 'hint') : null,
    transcript(s),
    actions(
      button('End call', a.endCall, 'danger', { id: 'call-end' }),
      live ? button(s.paused ? 'Resume' : 'Pause', a.togglePause, 'secondary', { id: 'call-pause', 'aria-pressed': s.paused ? 'true' : 'false' }) : null,
      live ? button(s.muted ? 'Unmute' : 'Mute', a.toggleMute, 'secondary', { id: 'call-mute', 'aria-pressed': s.muted ? 'true' : 'false' }) : null,
      button('Minimize', a.toggleMinimize, 'quiet', { id: 'call-minimize' })));
}
