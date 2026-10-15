// pairScreens.ts — Pair with a Mac, and "Pair with <Mac>?" (AASC-17).
import { h, icon } from './dom.js';
import { actions, alert, button, field, notice, para, pathRow, screen, status, toggle } from './parts.js';
import type { Screen, ScreenContext } from './screen.js';

type PairScreen = Extract<Screen, { name: 'pair' }>;
type ConfirmScreen = Extract<Screen, { name: 'confirm' }>;

export function renderNeedsApp(): HTMLElement {
  return screen('AASC', null,
    para('Open this in the AASC app on your phone.'),
    para('Pairing keeps a key in the phone’s secure storage, which a web browser doesn’t have.', 'hint'));
}

export function renderPair(s: PairScreen, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const back = ctx.macs.length ? { label: 'Your Macs', onClick: a.showMacs } : null;

  const scan = ctx.scannerAvailable
    ? button('Scan the QR code', a.scan, 'primary', { 'data-action': 'scan' })
    : null;
  scan?.prepend(icon('qr'));

  const pasteForm = h('form', {
    class: 'stack',
    attrs: { novalidate: true, 'aria-label': 'Paste the pairing link' },
    on: { submit: (e) => { e.preventDefault(); a.submitLink(); } },
  },
  field({
    id: 'pair-link', label: 'Pairing link', value: s.linkText, multiline: true, error: s.error,
    hint: ctx.scannerAvailable ? 'Or paste the link the QR holds.' : 'Scanning needs the AASC app. Paste the link the QR holds.',
    attrs: { inputmode: 'url', placeholder: 'https://aasc.work/pair#…' },
    onInput: (linkText) => a.remember({ linkText }),
  }),
  h('button', { class: `btn ${scan ? 'btn-secondary' : 'btn-primary'}`, attrs: { type: 'submit' } }, 'Continue'));

  const err = s.manualError;
  const manual = h('details', {
    class: 'manual',
    attrs: { open: s.manualOpen },
    on: { toggle: (e) => a.remember({ manualOpen: (e.target as HTMLDetailsElement).open }) },
  },
  h('summary', {}, 'Type the code instead'),
  h('form', {
    class: 'stack',
    attrs: { novalidate: true, 'aria-label': 'Type the pairing code' },
    on: { submit: (e) => { e.preventDefault(); a.submitManual(); } },
  },
  field({
    id: 'manual-address', label: 'Mac address', value: s.address,
    hint: 'Its Tailscale address (100.x.y.z), or its home-network address.',
    error: err?.field === 'address' ? err.message : null,
    attrs: { inputmode: 'decimal', placeholder: '100.101.102.103' },
    onInput: (address) => a.remember({ address }),
  }),
  field({
    id: 'manual-port', label: 'Port', value: s.port,
    error: err?.field === 'port' ? err.message : null,
    attrs: { inputmode: 'numeric' },
    onInput: (port) => a.remember({ port }),
  }),
  field({
    id: 'manual-code', label: 'Pairing code', value: s.code,
    hint: 'The 10 characters under the QR, like ABCDE‑FGHJK.',
    error: err?.field === 'code' ? err.message : null,
    attrs: { autocapitalize: 'characters', maxlength: 11, placeholder: 'ABCDE-FGHJK' },
    onInput: (code) => a.remember({ code }),
  }),
  h('button', { class: 'btn btn-secondary', attrs: { type: 'submit' } }, 'Continue')));

  return screen('Pair with a Mac', back,
    notice(s.notice),
    para('On your Mac, open AASC, click the devices chip in the top bar and press Pair a phone.'),
    scan,
    pasteForm,
    manual);
}

export function renderConfirm(s: ConfirmScreen, ctx: ScreenContext): HTMLElement {
  const a = ctx.actions;
  const { link } = s;
  const lanOnly = link.lan !== null && link.tailnet === null;
  const busy = s.busy !== null;
  const canPair = !busy && (!lanOnly || s.allowLan);

  const paths = h('ul', { class: 'paths', attrs: { 'aria-label': 'How this phone reaches the Mac' } },
    link.tailnet ? pathRow('tailnet', link.tailnet, link.port) : null,
    link.lan && s.allowLan ? pathRow('lan', link.lan, link.port) : null);

  const lanToggle = link.lan
    ? toggle({
        id: 'allow-lan',
        label: lanOnly ? 'Use the home network' : 'Also use the home network',
        checked: s.allowLan,
        hint: lanOnly
          ? `This Mac has no Tailscale address, so pairing needs ${link.lan}. It is unencrypted: use it only on a network you trust.`
          : `${link.lan} is faster at home but unencrypted: others on the same network could read it. You can change this later.`,
        onChange: (allowLan) => a.update({ allowLan }),
      })
    : null;

  const pairButton = button(busy ? 'Pairing…' : 'Pair', a.pair, 'primary', { disabled: !canPair, 'aria-busy': busy ? 'true' : null });

  return screen(`Pair with ${link.name}?`, { label: 'Back', onClick: a.cancelPair },
    para('Continue only if you just pressed Pair a phone on this Mac.'),
    paths,
    lanToggle,
    field({
      id: 'phone-name', label: 'Name for this phone', value: s.phoneName,
      hint: 'Your Mac shows it when it asks you to allow this phone.',
      attrs: { maxlength: 60, autocapitalize: 'words' },
      onInput: (phoneName) => a.remember({ phoneName }),
    }),
    alert(s.error),
    busy ? status(s.busy ?? '', true) : null,
    actions(pairButton, button('Cancel', a.cancelPair, 'quiet', { disabled: busy })));
}
