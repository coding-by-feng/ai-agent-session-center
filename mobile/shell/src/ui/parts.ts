// parts.ts — pieces every shell screen is built from (AASC-17).
import type { Candidate, PathKind } from '../connectionPlan.js';
import type { SavedMac } from '../savedMacs.js';
import { h, icon } from './dom.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

export function button(
  label: string, onClick: () => void, variant: ButtonVariant = 'secondary', attrs: Record<string, string | boolean | null> = {},
): HTMLButtonElement {
  return h('button', { class: `btn btn-${variant}`, attrs: { type: 'button', ...attrs }, on: { click: () => onClick() } }, label);
}

/** The page frame: an optional back button, the title (focused on arrival), the content. */
export function screen(title: string, back: { label: string; onClick: () => void } | null, ...content: Array<Node | null | false>): HTMLElement {
  const bar = back
    ? h('header', { class: 'bar' },
        h('button', { class: 'btn btn-quiet back', attrs: { type: 'button' }, on: { click: back.onClick } }, icon('back'), back.label))
    : null;
  return h('main', { class: 'screen' },
    bar,
    h('h1', { attrs: { tabindex: -1, id: 'screen-title' } }, title),
    ...content);
}

export function para(text: string, className = 'lead'): HTMLParagraphElement {
  return h('p', { class: className }, text);
}

/** A live status line, with a spinner while something is under way. */
export function status(text: string, busy: boolean): HTMLParagraphElement {
  return h('p', { class: 'status', attrs: { role: 'status', 'aria-live': 'polite' } },
    busy ? h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }) : null,
    text);
}

export function alert(text: string | null): HTMLParagraphElement | null {
  return text ? h('p', { class: 'alert', attrs: { role: 'alert' } }, icon('warning'), text) : null;
}

export function notice(text: string | null): HTMLParagraphElement | null {
  return text ? h('p', { class: 'notice', attrs: { role: 'status' } }, text) : null;
}

export function actions(...buttons: Array<HTMLElement | null>): HTMLDivElement {
  return h('div', { class: 'actions' }, ...buttons);
}

export const PATH_LABEL: Record<PathKind, string> = { tailnet: 'Tailscale', lan: 'Home network' };

/** One way to reach a Mac: Tailscale (encrypted) or the home network (unencrypted, marked). */
export function pathRow(kind: PathKind, address: string, port: number, extra?: string): HTMLLIElement {
  const encrypted = kind === 'tailnet';
  return h('li', { class: `path ${encrypted ? 'path-safe' : 'path-warn'}` },
    icon(encrypted ? 'lock' : 'warning'),
    h('span', { class: 'path-text' },
      h('span', { class: 'path-name' }, PATH_LABEL[kind]),
      h('span', { class: 'path-detail' }, `${address}:${port} · ${encrypted ? 'encrypted' : 'unencrypted'}${extra ? ` · ${extra}` : ''}`)));
}

export function candidateRow(c: Candidate, port: number, extra?: string): HTMLLIElement {
  return pathRow(c.kind, new URL(c.origin).hostname, port, extra);
}

/** "Tailscale", "Home network · unencrypted", or the order it will try. */
export function pathSummary(mac: SavedMac): { text: string; warn: boolean } {
  if (mac.lastPath === 'lan') return { text: 'Home network · unencrypted', warn: true };
  if (mac.lastPath === 'tailnet') return { text: 'Tailscale', warn: false };
  if (mac.lanAllowed && mac.lan) return { text: mac.tailnet ? 'Home network, then Tailscale' : 'Home network · unencrypted', warn: true };
  return { text: 'Tailscale', warn: false };
}

/** A labelled text field; its value comes back through `onInput`. */
export function field(opts: {
  id: string; label: string; value: string; hint?: string; error?: string | null;
  multiline?: boolean; attrs?: Record<string, string | boolean | number>; onInput: (value: string) => void;
}): HTMLDivElement {
  const describedBy = [opts.hint ? `${opts.id}-hint` : null, opts.error ? `${opts.id}-error` : null].filter(Boolean).join(' ') || null;
  const common = {
    id: opts.id,
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-invalid': opts.error ? 'true' : null,
    'aria-describedby': describedBy,
    ...opts.attrs,
  };
  const input = opts.multiline
    ? h('textarea', { class: 'input', attrs: { ...common, rows: 3 }, on: { input: (e) => opts.onInput((e.target as HTMLTextAreaElement).value) } })
    : h('input', { class: 'input', attrs: { type: 'text', ...common }, on: { input: (e) => opts.onInput((e.target as HTMLInputElement).value) } });
  input.value = opts.value;
  return h('div', { class: 'field' },
    h('label', { attrs: { for: opts.id } }, opts.label),
    opts.hint ? h('p', { class: 'hint', attrs: { id: `${opts.id}-hint` } }, opts.hint) : null,
    input,
    opts.error ? h('p', { class: 'field-error', attrs: { id: `${opts.id}-error` } }, opts.error) : null);
}

/** A checkbox styled as a switch, the whole row a 44px target. */
export function toggle(opts: { id: string; label: string; checked: boolean; hint?: string; onChange: (checked: boolean) => void }): HTMLDivElement {
  const input = h('input', {
    class: 'switch',
    attrs: { type: 'checkbox', role: 'switch', id: opts.id, 'aria-describedby': opts.hint ? `${opts.id}-hint` : null },
    on: { change: (e) => opts.onChange((e.target as HTMLInputElement).checked) },
  });
  input.checked = opts.checked;
  return h('div', { class: 'toggle' },
    h('label', { class: 'toggle-row', attrs: { for: opts.id } }, h('span', { class: 'toggle-label' }, opts.label), input),
    opts.hint ? h('p', { class: 'hint', attrs: { id: `${opts.id}-hint` } }, opts.hint) : null);
}
