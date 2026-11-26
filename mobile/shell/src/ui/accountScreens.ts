// accountScreens.ts — the AASC Cloud part of Your Macs (plan 17): who is signed in (menu: Sign out, Delete
// AASC Cloud account…) and the account's Macs this phone hasn't saved yet, each with Connect, or Offline
// when nothing reached it.
import type { AccountMac } from '../accountMacs.js';
import { accountReachKey } from '../macReach.js';
import { signInUnreadableText } from '../accountSignIn.js';
import { h, icon } from './dom.js';
import { actions, alert, button, para, screen, status } from './parts.js';
import { reachDot } from './macScreens.js';
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

/**
 * Nov 20 2026: asked before anything opens. Continue only leads to the match code and the sign-in sheet; the
 * deleting itself is the one button on the backend's page there.
 */
export function renderAccountDelete(ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  return screen('Delete your AASC Cloud account?', null,
    para('This removes your account, its devices, synced notes, resources and saved projects from AASC Cloud. '
      + 'Sessions and files on your computers are not touched. You finish in a Google sign-in sheet.'),
    actions(
      button('Continue', a.confirmDeleteAccount, 'danger'),
      button('Cancel', a.cancelDeleteAccount, 'secondary')));
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
      // Nov 27 2026: a row that already failed to connect says so itself (Offline / Not connected).
      step ? null : reachDot(ctx.reach.get(accountReachKey(mac.deviceId))),
      icon('laptop'),
      h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, mac.name), sub)),
    connect,
    note);
}

function listPart(view: AccountView, s: MacsScreen, ctx: ScreenContext): Node | null {
  if (view.macs.length) {
    return h('ul', { class: 'macs', attrs: { 'aria-label': 'On your AASC Cloud account' } }, ...view.macs.map((m) => accountRow(m, s, ctx)));
  }
  if (view.status === 'loading') return status('Looking for your account’s computers…', true);
  if (view.status === 'unavailable') {
    return h('div', { class: 'stack' },
      para('Couldn’t reach AASC Cloud to list your computers.', 'hint'),
      button('Try again', ctx.actions.refreshAccount, 'secondary', { 'aria-label': 'Ask AASC Cloud again' }));
  }
  if (view.status === 'unreadable') {
    // Not a sign-out: the token is in the vault, which couldn't be read (a locked keychain). Nothing was asked.
    return h('div', { class: 'stack' },
      para(signInUnreadableText(ctx.device), 'hint'),
      button('Try again', ctx.actions.refreshAccount, 'secondary'));
  }
  return para(view.listedAny
    ? `Every computer on your account is on this ${ctx.device}.`
    : 'No computers on your account yet. Sign in to AASC Cloud on a computer first.', 'hint');
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
          // Sign out can be undone (sign in again), so it is the plain button; only Delete looks destructive.
          button('Sign out of AASC Cloud', ctx.actions.signOutAccount, 'secondary'),
          para(`Computers saved on this ${ctx.device} stay.`, 'hint'),
          // Destructive, so apart from Sign out: its own group under a divider (a fixed gap).
          view.canDelete
            ? h('div', { class: 'account-delete' }, button('Delete AASC Cloud account…', ctx.actions.askDeleteAccount, 'danger'))
            : null)
      : null,
    listPart(view, s, ctx));
}
