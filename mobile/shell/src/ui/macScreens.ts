// macScreens.ts — Your Macs, and one Mac's settings (home network, unpair) (AASC-17).
import type { SavedMac } from '../savedMacs.js';
import { h, icon } from './dom.js';
import { actions, alert, button, notice, para, pathRow, pathSummary, screen, status, toggle } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type SettingsScreen = Extract<Screen, { name: 'settings' }>;

function macRow(mac: SavedMac, ctx: ScreenContext): HTMLLIElement {
  const a = ctx.actions;
  const pending = mac.status === 'pending';
  const path = pathSummary(mac);
  const sub = pending
    ? h('span', { class: 'mac-sub' }, 'Waiting for you to allow this phone')
    : h('span', { class: `mac-sub ${path.warn ? 'warn' : 'safe'}` }, icon(path.warn ? 'warning' : 'lock', 'icon icon-sm'), path.text);
  return h('li', { class: 'mac' },
    h('button', {
      class: 'mac-open',
      attrs: { type: 'button', 'data-mac': mac.id },
      on: { click: () => a.open(mac.id) },
    },
    icon('laptop'),
    h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, mac.name), sub),
    icon('chevron', 'icon chevron')),
    h('button', {
      class: 'btn btn-quiet icon-btn',
      attrs: { type: 'button', 'aria-label': `Settings for ${mac.name}` },
      on: { click: () => a.showSettings(mac.id) },
    }, icon('gear')));
}

export function renderMacs(s: Extract<Screen, { name: 'macs' }>, ctx: ScreenContext): HTMLElement {
  return screen('Your Macs', null,
    notice(s.notice),
    h('ul', { class: 'macs', attrs: { 'aria-label': 'Paired Macs' } }, ...ctx.macs.map((m) => macRow(m, ctx))),
    actions(button('Pair another Mac', ctx.actions.showPair, 'secondary')));
}

export function renderSettings(s: SettingsScreen, mac: SavedMac, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const busy = s.step === 'busy';

  const paths = h('ul', { class: 'paths', attrs: { 'aria-label': 'Addresses' } },
    mac.tailnet ? pathRow('tailnet', mac.tailnet, mac.port) : null,
    mac.lan ? pathRow('lan', mac.lan, mac.port, mac.lanAllowed ? 'tried first' : 'not used') : null);

  const lan = mac.lan
    ? toggle({
        id: 'settings-lan',
        label: 'Use the home network',
        checked: mac.lanAllowed,
        hint: 'Faster at home, but unencrypted: others on the same network could read it. Tailscale stays encrypted.',
        onChange: (allowed) => a.setLanAllowed(mac.id, allowed),
      })
    : para('This Mac has no home-network address, so only Tailscale is used.', 'hint');

  let unpair: HTMLElement;
  if (s.step === 'confirm' || busy) {
    unpair = h('div', { class: 'danger-zone', attrs: { role: 'group', 'aria-labelledby': 'unpair-q' } },
      h('p', { attrs: { id: 'unpair-q' } }, `Unpair from ${mac.name}? This phone loses access and forgets its key. Pair again to come back.`),
      busy ? status(`Telling ${mac.name}…`, true) : null,
      actions(
        button(busy ? 'Unpairing…' : 'Unpair', () => a.unpair(mac.id, false), 'danger', { disabled: busy, 'aria-busy': busy ? 'true' : null }),
        button('Keep it', () => a.keepPaired(mac.id), 'quiet', { disabled: busy })));
  } else if (s.step === 'unreachable') {
    unpair = h('div', { class: 'danger-zone' },
      alert(`Couldn’t reach ${mac.name}, so it still lists this phone.`),
      para('Remove it from this phone anyway, then revoke it in the Mac’s devices panel when you can.', 'hint'),
      actions(
        button('Remove anyway', () => a.unpair(mac.id, true), 'danger'),
        button('Keep it', () => a.keepPaired(mac.id), 'quiet')));
  } else {
    unpair = actions(button('Unpair this phone', () => a.askUnpair(mac.id), 'danger'));
  }

  return screen(mac.name, { label: 'Your Macs', onClick: a.showMacs },
    notice(s.notice),
    mac.phoneName ? para(`This phone is “${mac.phoneName}” on that Mac.`, 'hint') : null,
    actions(button(mac.status === 'pending' ? 'Check approval' : `Open ${mac.name}`, () => a.open(mac.id), 'primary', { disabled: busy })),
    h('h2', {}, 'Connection'),
    paths,
    lan,
    h('h2', {}, 'Unpair'),
    unpair);
}
