// macScreens.ts — Your Macs, and one Mac's settings (home network, unpair) (AASC-17).
import type { SavedMac } from '../savedMacs.js';
import { h, icon } from './dom.js';
import { actions, alert, button, notice, para, pathRow, pathSummary, screen, status, toggle } from './parts.js';
import type { Actions, Screen, ScreenContext, UnpairStep } from './screen.js';

type MacsScreen = Extract<Screen, { name: 'macs' }>;
type SettingsScreen = Extract<Screen, { name: 'settings' }>;

/** "Unpair from …?" and its answers: the same in a Mac's row of the list and on its settings. */
function unpairQuestion(mac: SavedMac, step: Exclude<UnpairStep, 'idle'>, a: Actions, className: string): HTMLElement {
  if (step === 'unreachable') {
    return h('div', { class: className },
      alert(`Couldn’t reach ${mac.name}, so it still lists this phone.`),
      para('Remove it from this phone anyway, then revoke it in the Mac’s devices panel when you can.', 'hint'),
      actions(
        button('Remove anyway', () => a.unpair(mac.id, true), 'danger'),
        button('Keep it', () => a.keepPaired(mac.id), 'quiet')));
  }
  const busy = step === 'busy';
  const question = `unpair-q-${mac.id}`;
  return h('div', { class: className, attrs: { role: 'group', 'aria-labelledby': question } },
    h('p', { attrs: { id: question } }, `Unpair from ${mac.name}? This phone loses access and forgets its key. Pair again to come back.`),
    busy ? status(`Telling ${mac.name}…`, true) : null,
    actions(
      button(busy ? 'Unpairing…' : 'Unpair', () => a.unpair(mac.id, false), 'danger', { disabled: busy, 'aria-busy': busy ? 'true' : null }),
      button('Keep it', () => a.keepPaired(mac.id), 'quiet', { disabled: busy })));
}

function macRow(mac: SavedMac, ctx: ScreenContext, asking: MacsScreen['unpair']): HTMLLIElement {
  const a = ctx.actions;
  const step = asking?.macId === mac.id ? asking.step : null;
  const busy = step === 'busy';
  const pending = mac.status === 'pending';
  const path = pathSummary(mac);
  const sub = pending
    ? h('span', { class: 'mac-sub' }, 'Waiting for you to allow this phone')
    : h('span', { class: `mac-sub ${path.warn ? 'warn' : 'safe'}` }, icon(path.warn ? 'warning' : 'lock', 'icon icon-sm'), path.text);
  // Unpairing asks inside the row tapped: two Macs can share a name (Oct 20 2026).
  return h('li', { class: 'mac', attrs: { 'data-unpairing': step ? 'true' : null } },
    h('button', {
      class: 'mac-open',
      attrs: { type: 'button', 'data-mac': mac.id, disabled: busy },
      on: { click: () => a.open(mac.id) },
    },
    icon('laptop'),
    h('span', { class: 'mac-text' }, h('span', { class: 'mac-name' }, mac.name), sub),
    icon('chevron', 'icon chevron')),
    h('button', {
      class: 'btn btn-quiet icon-btn',
      attrs: { type: 'button', 'aria-label': `Settings for ${mac.name}`, disabled: busy },
      on: { click: () => a.showSettings(mac.id) },
    }, icon('gear')),
    h('button', {
      class: 'btn btn-quiet icon-btn',
      attrs: { type: 'button', id: `unpair-${mac.id}`, 'aria-label': `Unpair from ${mac.name}`, 'aria-expanded': step ? 'true' : 'false', disabled: busy },
      on: { click: () => a.askUnpair(mac.id) },
    }, icon('trash')),
    step ? unpairQuestion(mac, step, a, 'mac-unpair') : null);
}

export function renderMacs(s: Extract<Screen, { name: 'macs' }>, ctx: ScreenContext): HTMLElement {
  return screen('Your Macs', null,
    notice(s.notice),
    h('ul', { class: 'macs', attrs: { 'aria-label': 'Paired Macs' } }, ...ctx.macs.map((m) => macRow(m, ctx, s.unpair))),
    actions(
      button('Pair another Mac', ctx.actions.showPair, 'secondary'),
      button('This phone', ctx.actions.showPhone, 'quiet')));
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

  const unpair = s.step === 'idle'
    ? actions(button('Unpair this phone', () => a.askUnpair(mac.id), 'danger'))
    : unpairQuestion(mac, s.step, a, 'danger-zone');

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
