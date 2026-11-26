// @vitest-environment jsdom
// callAddSheet.test.ts — the voice call's ＋ Add sheet (Nov 24 2026). It lives in <body>, outside the call screen
// the app redraws every second, so its filter box and lists keep their caret and scroll.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openCallAddSheet, type CallAddHandlers } from './callAddSheet.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function handlers(over: Partial<CallAddHandlers> = {}): CallAddHandlers {
  return {
    addFiles: vi.fn(),
    loadCommands: vi.fn(async () => [
      { token: '/expense-log', description: 'Log an expense from a receipt' },
      { token: '/deploy-krt', description: 'Deploy KRT' },
    ]),
    pickCommand: vi.fn(),
    loadMemory: vi.fn(async () => [
      { id: 'm2', kind: 'correction', meant: 'AASC', heard: 'ASC', status: 'proposed' as const },
      { id: 'm1', kind: 'preference', meant: 'Use Codex for reviews', heard: '', status: 'kept' as const },
    ]),
    decideMemory: vi.fn(async () => true),
    onClosed: vi.fn(),
    ...over,
  };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonNamed = (name: string | RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
  .find((b) => (typeof name === 'string' ? (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name : name.test(b.textContent ?? '')));

afterEach(() => { document.body.replaceChildren(); });

describe('openCallAddSheet', () => {
  it('is a modal dialog in <body> listing what can be added', () => {
    openCallAddSheet(handlers());
    const d = dialog();
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(d?.closest('body')).toBe(document.body);
    const rows = Array.from(d?.querySelectorAll('.call-sheet-row .call-sheet-label') ?? []).map((n) => n.textContent);
    expect(rows).toEqual(['Take a photo', 'Photos & videos', 'Record video', 'File', 'Skill or command', 'Memory']);
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(d);
  });

  it('opens the right picker for each source: camera, library, video, any file', () => {
    openCallAddSheet(handlers());
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="file"]'));
    const byName = Object.fromEntries(inputs.map((i) => [i.dataset.source, i]));
    expect(byName.camera.accept).toBe('image/*');
    expect(byName.camera.getAttribute('capture')).toBe('environment');
    expect(byName.library.accept).toBe('image/*,video/*');
    expect(byName.library.multiple).toBe(true);
    // Its own input: Android's capture turns any video/* in a list into a video-only camera.
    expect(byName.video.accept).toBe('video/*');
    expect(byName.video.getAttribute('capture')).toBe('environment');
    expect(byName.file.accept).toBe('');
    const click = vi.spyOn(byName.camera, 'click');
    buttonNamed(/Take a photo/)?.click();
    expect(click).toHaveBeenCalled();
  });

  it('hands picked files over and closes', () => {
    const h = handlers();
    openCallAddSheet(h);
    const input = document.querySelector<HTMLInputElement>('[data-source="file"]')!;
    const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(h.addFiles).toHaveBeenCalledWith([file]);
    expect(dialog()).toBeNull();
    expect(h.onClosed).toHaveBeenCalled();
  });

  it('lists commands, filters them as you type, and picks one', async () => {
    const h = handlers();
    openCallAddSheet(h);
    buttonNamed(/Skill or command/)?.click();
    await flush();
    const filter = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="search"]')!;
    expect(filter.getAttribute('aria-label')).toBe('Filter commands');
    const visible = () => Array.from(document.querySelectorAll<HTMLElement>('.call-sheet-list li'))
      .filter((li) => !li.hidden).map((li) => li.querySelector('.call-sheet-label')?.textContent);
    expect(visible()).toEqual(['/expense-log', '/deploy-krt']);
    filter.value = 'receipt';
    filter.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['/expense-log']);
    buttonNamed(/\/expense-log/)?.click();
    expect(h.pickCommand).toHaveBeenCalledWith('/expense-log');
    expect(dialog()).toBeNull();
  });

  it('says so when the commands cannot be read', async () => {
    openCallAddSheet(handlers({ loadCommands: vi.fn(async () => null) }));
    buttonNamed(/Skill or command/)?.click();
    await flush();
    expect(dialog()?.textContent).toContain('Couldn’t read the commands from the Mac.');
  });

  it('shows call memory: Keep or Skip a proposal, Forget a kept item', async () => {
    const h = handlers();
    openCallAddSheet(h);
    buttonNamed(/Memory/)?.click();
    await flush();
    const rows = Array.from(document.querySelectorAll('.call-memory-row')).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('AASC');
    expect(rows[0]).toContain('Proposed');
    expect(rows[1]).toContain('Kept');
    buttonNamed('Keep: AASC')?.click();
    await flush();
    expect(h.decideMemory).toHaveBeenCalledWith('m2', 'keep');
    expect(document.querySelectorAll('.call-memory-row')[0].textContent).toContain('Kept');
    buttonNamed('Forget: Use Codex for reviews')?.click();
    await flush();
    expect(h.decideMemory).toHaveBeenCalledWith('m1', 'retire');
    expect(Array.from(document.querySelectorAll('.call-memory-row')).map((r) => r.textContent)).not.toContain(expect.stringContaining('Codex'));
  });

  it('goes back from a list to the menu, and closes on Escape', async () => {
    const h = handlers();
    openCallAddSheet(h);
    buttonNamed(/Memory/)?.click();
    await flush();
    buttonNamed('Back')?.click();
    expect(dialog()?.querySelector('.call-sheet-row')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog()).toBeNull();
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });

  it('closes from outside', () => {
    const h = handlers();
    const sheet = openCallAddSheet(h);
    sheet.close();
    expect(dialog()).toBeNull();
    expect(h.onClosed).toHaveBeenCalledTimes(1);
  });
});
