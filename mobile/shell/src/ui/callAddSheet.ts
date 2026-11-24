// callAddSheet.ts — the voice call's ＋ Add sheet (Nov 24 2026): take a photo, pick photos and videos, record a
// video, pick any file, pick a skill or command, or look over the call memory. It is drawn into <body>, outside the
// call screen that the app redraws every second, so the filter box keeps its caret (and a Chinese IME its
// composition), the lists keep their scroll, and the file inputs survive until the picker answers.
// What is added goes to the Mac, which holds it for the person's next question (callAdd.ts).
import type { CommandChoice, MemoryRow } from '../callAdd.js';
import { h, icon } from './dom.js';

export interface CallAddHandlers {
  addFiles(files: readonly File[]): void;
  loadCommands(): Promise<CommandChoice[] | null>;
  pickCommand(token: string): void;
  loadMemory(): Promise<MemoryRow[] | null>;
  decideMemory(id: string, action: 'keep' | 'skip' | 'retire'): Promise<boolean>;
  /** After the sheet closed, however it closed (focus goes back to ＋ Add). */
  onClosed(): void;
}

export interface CallAddSheet {
  close(): void;
}

type Source = 'camera' | 'library' | 'video' | 'file';

const INPUTS: Record<Source, { accept: string; capture?: string; multiple?: boolean }> = {
  camera: { accept: 'image/*', capture: 'environment' },
  library: { accept: 'image/*,video/*', multiple: true },
  // Its own input: Android's capture turns any video/* in a list into a video-only camera.
  video: { accept: 'video/*', capture: 'environment' },
  file: { accept: '', multiple: true },
};

const KIND_WORDS: Record<string, string> = { preference: 'Preference', correction: 'Correction', pattern: 'Habit' };

export function openCallAddSheet(handlers: CallAddHandlers): CallAddSheet {
  let open = true;
  let gen = 0;
  const body = h('div', { class: 'call-sheet-body' });
  const title = h('h2', { class: 'call-sheet-title', attrs: { id: 'call-sheet-title' } });
  const back = h('button', { class: 'btn btn-quiet call-sheet-back', attrs: { type: 'button', 'aria-label': 'Back' }, on: { click: () => showMenu() } }, icon('back'));
  const closeButton = h('button', { class: 'btn btn-quiet', attrs: { type: 'button' }, on: { click: () => close() } }, 'Close');

  const inputs = Object.fromEntries((Object.keys(INPUTS) as Source[]).map((source) => {
    const spec = INPUTS[source];
    const input = h('input', {
      class: 'call-sheet-input',
      attrs: { type: 'file', accept: spec.accept, capture: spec.capture, multiple: spec.multiple, 'data-source': source, tabindex: -1, 'aria-hidden': 'true' },
      on: {
        change: () => {
          const files = Array.from(input.files ?? []);
          if (files.length === 0) return;
          handlers.addFiles(files);
          close();
        },
      },
    });
    return [source, input];
  })) as Record<Source, HTMLInputElement>;

  const panel = h('section', {
    class: 'call-sheet',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'call-sheet-title', tabindex: -1 },
  },
  h('header', { class: 'call-sheet-head' }, back, title, closeButton),
  body,
  ...Object.values(inputs));

  const layer = h('div', {
    class: 'call-sheet-layer',
    on: { pointerdown: (e) => { if (e.target === layer) close(); } },
  }, panel);

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the sheet.
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([hidden]), input[type="search"]'))
      .filter((el) => !el.closest('[hidden]'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function close(): void {
    if (!open) return;
    open = false;
    gen += 1;
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    handlers.onClosed();
  }

  function view(name: string, withBack: boolean, ...content: Array<Node | null>): void {
    gen += 1;
    title.textContent = name;
    back.hidden = !withBack;
    body.replaceChildren(...content.filter((n): n is Node => n !== null));
  }

  function row(label: string, detail: string | null, onClick: () => void, chevron = false): HTMLButtonElement {
    return h('button', { class: 'call-sheet-row', attrs: { type: 'button' }, on: { click: onClick } },
      h('span', { class: 'call-sheet-text' },
        h('span', { class: 'call-sheet-label' }, label),
        detail ? h('span', { class: 'call-sheet-detail' }, detail) : null),
      chevron ? icon('chevron', 'icon call-sheet-chevron') : null);
  }

  function showMenu(): void {
    view('Add to the call', false,
      h('div', { class: 'call-sheet-rows' },
        row('Take a photo', null, () => inputs.camera.click()),
        row('Photos & videos', null, () => inputs.library.click()),
        row('Record video', 'Up to 100 MB', () => inputs.video.click()),
        row('File', 'Any file, up to 100 MB', () => inputs.file.click()),
        row('Skill or command', null, () => void showCommands(), true),
        row('Memory', 'What AASC keeps from your calls', () => void showMemory(), true)),
      h('p', { class: 'hint call-sheet-hint' }, 'It goes to AASC with the next thing you say.'));
    // The sheet itself, not its first row: a row focused after a tap draws a focus ring (Tab then reaches the rows).
    panel.focus({ preventScroll: true });
  }

  function waiting(text: string): HTMLElement {
    return h('p', { class: 'status', attrs: { role: 'status' } }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), text);
  }

  async function showCommands(): Promise<void> {
    view('Skill or command', true, waiting('Reading the commands…'));
    panel.focus({ preventScroll: true });
    const my = gen;
    const choices = await handlers.loadCommands();
    if (!open || my !== gen) return;
    if (!choices) { view('Skill or command', true, h('p', { class: 'alert', attrs: { role: 'alert' } }, 'Couldn’t read the commands from the Mac.')); return; }
    const none = h('p', { class: 'hint', attrs: { role: 'status' } }, 'No command matches.');
    none.hidden = choices.length > 0;
    const items = choices.map((c) => h('li', {},
      h('button', { class: 'call-sheet-row', attrs: { type: 'button' }, on: { click: () => { handlers.pickCommand(c.token); close(); } } },
        h('span', { class: 'call-sheet-text' },
          h('span', { class: 'call-sheet-label' }, c.token),
          c.description ? h('span', { class: 'call-sheet-detail call-sheet-clamp' }, c.description) : null))));
    const filter = h('input', {
      class: 'input call-sheet-filter',
      attrs: { type: 'search', 'aria-label': 'Filter commands', placeholder: 'Filter', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' },
      on: {
        input: () => {
          const q = filter.value.trim().toLowerCase();
          let shown = 0;
          items.forEach((li, i) => {
            const c = choices[i];
            li.hidden = q !== '' && !c.token.toLowerCase().includes(q) && !c.description.toLowerCase().includes(q);
            if (!li.hidden) shown += 1;
          });
          none.hidden = shown > 0;
        },
      },
    });
    view('Skill or command', true, filter, h('ul', { class: 'call-sheet-list' }, ...items), none);
  }

  function memoryRow(r: MemoryRow, onChange: (next: MemoryRow | null) => void): HTMLLIElement {
    const note = h('p', { class: 'call-memory-note', attrs: { role: 'status' } });
    const decide = (action: 'keep' | 'skip' | 'retire') => async () => {
      note.textContent = '';
      const ok = await handlers.decideMemory(r.id, action);
      if (!open) return;
      if (!ok) { note.textContent = 'Couldn’t save that. Try again.'; return; }
      onChange(action === 'keep' ? { ...r, status: 'kept' } : null);
    };
    const act = (label: string, action: 'keep' | 'skip' | 'retire', variant: string) =>
      h('button', { class: `btn btn-${variant}`, attrs: { type: 'button', 'aria-label': `${label}: ${r.meant}` }, on: { click: () => void decide(action)() } }, label);
    return h('li', { class: 'call-memory-row', attrs: { 'data-status': r.status } },
      h('p', { class: 'call-memory-meant' }, r.meant),
      h('p', { class: 'call-memory-meta' },
        h('span', { class: 'call-memory-status' }, r.status === 'kept' ? 'Kept' : 'Proposed'),
        ` · ${KIND_WORDS[r.kind] ?? 'Note'}`,
        r.kind === 'correction' && r.heard ? ` · heard “${r.heard}”` : ''),
      h('div', { class: 'call-memory-actions' },
        ...(r.status === 'proposed' ? [act('Keep', 'keep', 'primary'), act('Skip', 'skip', 'secondary')] : [act('Forget', 'retire', 'secondary')])),
      note);
  }

  async function showMemory(): Promise<void> {
    view('Memory', true, waiting('Reading the call memory…'));
    panel.focus({ preventScroll: true });
    const my = gen;
    const rows = await handlers.loadMemory();
    if (!open || my !== gen) return;
    if (!rows) { view('Memory', true, h('p', { class: 'alert', attrs: { role: 'alert' } }, 'Couldn’t read the call memory from the Mac.')); return; }
    let current = rows;
    const list = h('ul', { class: 'call-sheet-list call-memory' });
    const empty = h('p', { class: 'hint' }, 'Nothing kept from your calls yet.');
    const draw = () => {
      list.replaceChildren(...current.map((r) => memoryRow(r, (next) => {
        current = next ? current.map((x) => (x.id === r.id ? next : x)) : current.filter((x) => x.id !== r.id);
        draw();
      })));
      empty.hidden = current.length > 0;
    };
    draw();
    view('Memory', true, list, empty);
  }

  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
  showMenu();
  return { close };
}
