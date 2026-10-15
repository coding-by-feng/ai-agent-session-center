// statusScreens.ts — Approve on your Mac, Opening…, and Can't reach (AASC-17).
import { candidates } from '../connectionPlan.js';
import type { SavedMac } from '../savedMacs.js';
import { h } from './dom.js';
import { actions, alert, button, candidateRow, para, pathRow, screen, status } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type ApproveScreen = Extract<Screen, { name: 'approve' }>;
type ConnectingScreen = Extract<Screen, { name: 'connecting' }>;
type OfflineScreen = Extract<Screen, { name: 'offline' }>;

/** "482913" → "482 913", read out digit by digit. */
function confirmCode(code: string): HTMLElement {
  return h('p', { class: 'code', attrs: { 'aria-label': `Code ${code.split('').join(' ')}` } },
    h('span', { attrs: { 'aria-hidden': 'true' } }, `${code.slice(0, 3)} ${code.slice(3)}`));
}

export function renderApprove(s: ApproveScreen, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const { mac } = s;
  if (s.state === 'refused') {
    return screen('Not allowed', { label: 'Your Macs', onClick: a.showMacs },
      para(`${mac.name} refused this phone, or the request expired. Requests last 10 minutes.`),
      para('Press Pair a phone on the Mac again to start over.', 'hint'),
      actions(button('Pair again', a.showPair, 'primary')));
  }

  const line: Record<Exclude<typeof s.state, 'refused'>, [string, boolean]> = {
    waiting: [`Waiting for ${mac.name}…`, true],
    unreachable: [`Can’t reach ${mac.name} right now. Still trying…`, true],
    stalled: ['Still waiting. Allow this phone on your Mac, then check again.', false],
    error: [s.message ?? 'Something went wrong. Still trying…', true],
    cancelling: ['Cancelling…', true],
  };
  const [text, busy] = line[s.state];

  return screen('Approve on your Mac', null,
    para(`${mac.name} asks: Allow “${mac.phoneName || 'this phone'}”? Press Allow only if it shows this code:`),
    mac.confirmCode ? confirmCode(mac.confirmCode) : para('This phone lost its code. Cancel and pair again.', 'hint'),
    status(text, busy),
    para('Codes don’t match? Press Deny on your Mac: someone else scanned your QR.', 'hint'),
    s.state === 'cancelling' ? null : actions(
      s.state === 'stalled' ? button('Check again', () => a.checkAgain(mac.id), 'primary') : null,
      button('Cancel pairing', () => a.cancelApproval(mac.id), 'quiet')));
}

export function renderConnecting(s: ConnectingScreen, mac: SavedMac, ctx: ScreenContext): HTMLElement {
  return screen(s.reauth ? `Signing in to ${mac.name}` : `Opening ${mac.name}`, null,
    s.reauth ? para('Your session ended, so the app signs in again with this phone’s key.') : null,
    status(s.status, true),
    actions(button('Cancel', ctx.actions.showMacs, 'quiet')));
}

export function renderOffline(s: OfflineScreen, mac: SavedMac, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const tried = s.tried.length ? s.tried : candidates(mac);
  const lanUnused = mac.lan !== null && !mac.lanAllowed;

  const list = h('ul', { class: 'paths', attrs: { 'aria-label': 'Paths tried' } },
    ...tried.map((c) => candidateRow(c, mac.port, 'no answer')),
    lanUnused && mac.lan ? pathRow('lan', mac.lan, mac.port, 'not allowed') : null);

  const title = s.message ? `Couldn’t open ${mac.name}` : `Can’t reach ${mac.name}`;
  return screen(title, { label: 'Your Macs', onClick: a.showMacs },
    alert(s.message),
    tried.length || lanUnused ? h('h2', {}, tried.length ? 'Tried' : 'Paths') : null,
    list,
    tried.length === 0 ? para('This Mac has no Tailscale address and the home network isn’t allowed for it.', 'lead') : null,
    s.message ? null : para('Check that Tailscale is on for both devices and AASC is running on the Mac.', 'hint'),
    lanUnused ? para('At home? Allowing the home network for this Mac may reach it (unencrypted).', 'hint') : null,
    actions(
      button('Try again', a.retry, 'primary'),
      lanUnused ? button('Allow the home network…', () => a.showSettings(mac.id), 'secondary') : button('Mac settings', () => a.showSettings(mac.id), 'secondary')));
}
