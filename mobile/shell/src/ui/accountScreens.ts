// accountScreens.ts — the AASC Cloud part of Your Macs (plan 17): who is signed in (menu: Sign out) and
// the account's Macs this phone hasn't saved yet, each with Connect, or Offline when nothing reached it.
import type { AccountMac } from '../accountMacs.js';
import { h, icon } from './dom.js';
import { actions, alert, button, para, screen, status } from './parts.js';
import type { AccountView, Screen, ScreenContext } from './screen.js';

type MacsScreen = Extract<Screen, { name: 'macs' }>;

/**
 * Review M2: the code the backend's confirm page will show for this sign-in, before the sheet opens. The letters are
 * read one by one (aria-label), as the Approve screen's digits are.
 */
export function renderAccountMatch(s: Extract<Screen, { name: 'account-match' }>, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  return screen('Check this code', null,
    h('p', { class: 'code match-code', attrs: { 'aria-label': `Code ${s.code.split('').join(' ')}` } }, s.code),
    para('You’ll see the same code on the next page. Continue only if they match.'),
    s.busy ? status('Waiting for the sign-in page…', true) : null,
    actions(
      button('Continue', a.confirmAccountMatch, 'primary', { disabled: s.busy, 'aria-busy': s.busy ? 'true' : null }),
      button('Cancel', a.cancelAccountMatch, 'secondary', { disabled: s.busy })));
}

function accountRow(mac: AccountMac, s: MacsScreen, ctx: ScreenContext): HTMLLIElement {
  const a = ctx.actions;
  const mine = s.enroll?.deviceId === mac.deviceId ? s.enroll : null;
  const busyElsewhere = s.enroll?.step === 'busy' && !mine;
  const step = mine?.step ?? null;
  const again = step === 'offline' || step === 'failed';
  const sub = step === 'offline'
    ? h('span', { class: 'mac-sub warn' }, icon('warning', 'icon icon-sm'), 'Offline')
    : h('span', { class: 'mac-sub' }, step === 'failed' ? 'Not connected' : `Not on this ${ctx.device} yet`);
  const connect = button(
    step === 'busy' ? 'Connecting…' : again ? 'Try again' : 'Connect',
    () => a.enrollMac(mac.deviceId),
    'secondary',
    {
      'aria-label': again ? `Try connecting to ${mac.name} again` : `Connect to ${mac.name}`,
      'aria-busy': step === 'busy' ? 'true' : null,
      disabled: step === 'busy' || busyElsewhere,
    },
  );
  connect.classList.add('mac-connect');
  const note = !mine?.message
    ? null
    : step === 'busy'
      ? h('div', { class: 'mac-note' }, status(mine.message, true))
      : h('div', { class: 'mac-note' }, step === 'failed' ? alert(mine.message) : para(mine.message, 'hint'));
  return h('li', { class: 'mac', attrs: { 'data-enroll': step } },
    h('div', { class: 'mac-info' },
      icon('laptop'),
      h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, mac.name), sub)),
    connect,
    note);
}

function listPart(view: AccountView, s: MacsScreen, ctx: ScreenContext): Node | null {
  if (view.macs.length) {
    return h('ul', { class: 'macs', attrs: { 'aria-label': 'On your AASC Cloud account' } }, ...view.macs.map((m) => accountRow(m, s, ctx)));
  }
  if (view.status === 'loading') return status('Looking for your account’s Macs…', true);
  if (view.status === 'unavailable') {
    return h('div', { class: 'stack' },
      para('Couldn’t reach AASC Cloud to list your Macs.', 'hint'),
      button('Try again', ctx.actions.refreshAccount, 'secondary', { 'aria-label': 'Ask AASC Cloud again' }));
  }
  return para(view.listedAny
    ? `Every Mac on your account is on this ${ctx.device}.`
    : 'No Macs on your account yet. Sign in to AASC Cloud on a Mac first.', 'hint');
}

export function renderAccountSection(s: MacsScreen, ctx: ScreenContext): HTMLElement | null {
  const view = ctx.account;
  if (!view) return null;
  const open = s.accountMenu === true;
  return h('section', { class: 'account', attrs: { 'aria-labelledby': 'account-title' } },
    h('h2', { attrs: { id: 'account-title' } }, 'AASC Cloud'),
    h('div', { class: 'account-head' },
      h('span', { class: 'account-who' }, icon('cloud', 'icon icon-sm'), view.email ? `Signed in as ${view.email}` : 'Signed in'),
      h('button', {
        class: 'btn btn-quiet account-menu-btn',
        attrs: { type: 'button', 'aria-label': 'AASC Cloud account', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'account-menu' },
        on: { click: () => ctx.actions.toggleAccountMenu() },
      }, 'Account', icon('chevron', `icon icon-sm account-caret${open ? ' open' : ''}`))),
    open
      ? h('div', { class: 'account-menu', attrs: { id: 'account-menu' } },
          button('Sign out of AASC Cloud', ctx.actions.signOutAccount, 'danger'),
          para(`Macs saved on this ${ctx.device} stay.`, 'hint'))
      : null,
    listPart(view, s, ctx));
}
