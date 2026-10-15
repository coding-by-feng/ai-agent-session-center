// extraScreens.ts — Share to a session, Locked, and This phone (AASC-21, AASC-19).
import { RELOCK_CHOICES } from '../biometricLock.js';
import { sharePreview } from '../shareFlow.js';
import { h, icon } from './dom.js';
import { actions, alert, button, notice, para, screen, status, toggle } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type ShareScreen = Extract<Screen, { name: 'share' }>;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  approval: 'Needs approval', input: 'Waiting for input', working: 'Working', prompting: 'Working',
  waiting: 'Finished its turn', idle: 'Idle', connecting: 'Starting',
};

export function renderShare(s: ShareScreen, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const mac = ctx.macs.find((m) => m.id === s.macId) ?? null;
  const head = [
    para('Add to a session’s queue. It arrives paused: nothing runs until you turn it on.'),
    h('p', { class: 'share-preview' }, sharePreview(s.share)),
  ];

  let body: Array<Node | null>;
  switch (s.step) {
    case 'pick-mac':
      body = [
        h('h2', {}, 'Which Mac'),
        h('ul', { class: 'macs', attrs: { 'aria-label': 'Paired Macs' } }, ...ctx.macs.map((m) => h('li', { class: 'mac' },
          h('button', { class: 'mac-open', attrs: { type: 'button' }, on: { click: () => a.shareTo(m.id) } },
            icon('laptop'), h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, m.name)), icon('chevron', 'icon chevron'))))),
      ];
      break;
    case 'loading':
    case 'sending':
      body = [status(s.step === 'loading' ? `Getting the sessions on ${mac?.name ?? 'your Mac'}…` : 'Adding…', true)];
      break;
    case 'pick-session':
      body = [
        h('h2', {}, `Sessions on ${mac?.name ?? 'your Mac'}`),
        s.targets.length
          ? h('ul', { class: 'macs', attrs: { 'aria-label': 'Sessions' } }, ...s.targets.map((t) => h('li', { class: 'mac' },
            h('button', { class: 'mac-open', attrs: { type: 'button' }, on: { click: () => a.shareSession(t.sessionId) } },
              h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, t.title),
                h('span', { class: 'mac-sub' }, STATUS_TEXT[t.status] ?? t.status)),
              icon('chevron', 'icon chevron')))))
          : para('No session on this Mac is shared with this phone. Share one with it on the Mac, then try again.', 'hint'),
      ];
      break;
    case 'done':
    case 'error':
      body = [s.added ? notice(s.message) : alert(s.message)];
      break;
  }

  const finished = s.step === 'done' || s.step === 'error';
  return screen('Share to AASC', null,
    ...head,
    ...body,
    actions(
      finished && s.added && mac ? button(`Open ${mac.name}`, () => a.open(mac.id), 'primary') : null,
      finished && !s.added && ctx.macs.length === 0 ? button('Pair a Mac', a.showPair, 'primary') : null,
      button(finished ? 'Done' : 'Cancel', a.finishShare, finished && !s.added ? 'secondary' : 'quiet', { disabled: s.step === 'sending' })));
}

export function renderLocked(s: Extract<Screen, { name: 'locked' }>, ctx: ScreenContext): HTMLElement {
  return screen('AASC is locked', null,
    para('Unlock with your fingerprint, face or screen lock to reach your Macs.'),
    s.failed ? alert('Not unlocked. Try again.') : null,
    s.busy ? status('Waiting for you to unlock…', true) : null,
    actions(button('Unlock', ctx.actions.unlock, 'primary', { disabled: s.busy })));
}

export function renderPhone(s: Extract<Screen, { name: 'phone' }>, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const lock = ctx.lock;
  const lockPart: Array<Node | null> = lock
    ? [
        toggle({
          id: 'phone-lock',
          label: 'Lock with fingerprint or face',
          checked: lock.enabled,
          hint: lock.available
            ? 'Asks when AASC starts, after the phone restarts, and when you come back after the time below.'
            : 'Set up a fingerprint, face or screen lock in the phone’s settings first.',
          onChange: (on) => a.setLockEnabled(on),
        }),
        lock.enabled
          ? h('div', { class: 'field' },
              h('label', { attrs: { for: 'phone-relock' } }, 'Ask again after'),
              (() => {
                const select = h('select', {
                  class: 'input',
                  attrs: { id: 'phone-relock' },
                  on: { change: (e) => a.setRelockMinutes(Number((e.target as HTMLSelectElement).value)) },
                }, ...RELOCK_CHOICES.map((m) => h('option', { attrs: { value: m, selected: m === lock.relockAfterMinutes } },
                  m === 0 ? 'Every time' : m === 60 ? '1 hour away' : `${m} minute${m === 1 ? '' : 's'} away`)));
                return select;
              })())
          : null,
      ]
    : [para('The lock isn’t available in this build.', 'hint')];

  return screen('This phone', { label: 'Your Macs', onClick: a.showMacs },
    notice(s.notice),
    h('h2', {}, 'Lock'),
    ...lockPart,
    h('h2', {}, 'Notifications'),
    para(ctx.pushNote, 'hint'));
}
