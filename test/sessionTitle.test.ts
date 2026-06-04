import { describe, it, expect } from 'vitest';
import {
  makeShortTitle,
  isCloneForkTemplateTitle,
  buildAutoTitle,
} from '../server/sessionTitle.js';

describe('makeShortTitle', () => {
  it('returns empty string for empty/whitespace input', () => {
    expect(makeShortTitle('')).toBe('');
    expect(makeShortTitle('   ')).toBe('');
  });

  it('strips a single leading polite prefix and capitalizes', () => {
    expect(makeShortTitle('please fix the login bug')).toBe('Fix the login bug');
    expect(makeShortTitle('Can you add a dark mode toggle')).toBe('Add a dark mode toggle');
    expect(makeShortTitle('I need to refactor the parser')).toBe('Refactor the parser');
  });

  it('takes only the first sentence', () => {
    expect(makeShortTitle('Fix the bug. Then deploy it.')).toBe('Fix the bug');
    expect(makeShortTitle('Add tests! And docs.')).toBe('Add tests');
  });

  it('takes only the first line', () => {
    expect(makeShortTitle('Update README\nand also the changelog')).toBe('Update README');
  });

  it('truncates to ~60 chars', () => {
    const long = 'a'.repeat(120);
    const out = makeShortTitle(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out[0]).toBe('A');
  });
});

describe('isCloneForkTemplateTitle', () => {
  it('matches the clone/fork template prefixes', () => {
    expect(isCloneForkTemplateTitle('Clone of my-project')).toBe(true);
    expect(isCloneForkTemplateTitle('Fork of Thesis')).toBe(true);
    expect(isCloneForkTemplateTitle('Clone of Clone of KTS')).toBe(true);
    expect(isCloneForkTemplateTitle('Fork of localhost:/home/me/app')).toBe(true);
  });

  it('does not match real / manual / empty titles', () => {
    expect(isCloneForkTemplateTitle('agent-manager #2 — Fix the bug')).toBe(false);
    expect(isCloneForkTemplateTitle('My Forked Experiment')).toBe(false);
    expect(isCloneForkTemplateTitle('Cloned of X')).toBe(false);
    expect(isCloneForkTemplateTitle('clone of x')).toBe(false); // case-sensitive: only the generated template
    expect(isCloneForkTemplateTitle('')).toBe(false);
    expect(isCloneForkTemplateTitle(null)).toBe(false);
    expect(isCloneForkTemplateTitle(undefined)).toBe(false);
  });
});

describe('buildAutoTitle', () => {
  it('builds "<project> #<n> — <short prompt>" when a prompt is present', () => {
    expect(buildAutoTitle('agent-manager', 3, 'please fix the login bug')).toBe(
      'agent-manager #3 — Fix the login bug'
    );
  });

  it('falls back to "<project> — Session #<n>" for an empty/uninformative prompt', () => {
    expect(buildAutoTitle('agent-manager', 2, '')).toBe('agent-manager — Session #2');
    expect(buildAutoTitle('agent-manager', 5, '   ')).toBe('agent-manager — Session #5');
  });

  it('matches the exact format the live session-store produced before extraction', () => {
    // Regression guard: format must stay byte-identical to the inlined version.
    expect(buildAutoTitle('proj', 1, 'Add a feature')).toBe('proj #1 — Add a feature');
  });
});

describe('clone/fork re-title composition (the session-store guard)', () => {
  // Mirrors the USER_PROMPT_SUBMIT guard in sessionStore.handleEvent:
  //   if (!session.title || isCloneForkTemplateTitle(session.title)) title = buildAutoTitle(...)
  const retitle = (currentTitle: string, project: string, counter: number, prompt: string) =>
    !currentTitle || isCloneForkTemplateTitle(currentTitle)
      ? buildAutoTitle(project, counter, prompt)
      : currentTitle;

  it('replaces a "Clone of …" template title with a context title on first prompt', () => {
    expect(retitle('Clone of KTS', 'KTS', 2, 'please add a settings page')).toBe(
      'KTS #2 — Add a settings page'
    );
  });

  it('replaces a recursive "Clone of Clone of …" title', () => {
    expect(retitle('Clone of Clone of KTS', 'KTS', 1, 'refactor the router')).toBe(
      'KTS #1 — Refactor the router'
    );
  });

  it('is one-shot — the regenerated title is not re-titled again', () => {
    const once = retitle('Fork of Thesis', 'Thesis', 1, 'write the intro');
    expect(once).toBe('Thesis #1 — Write the intro');
    // Second prompt: title no longer matches the template, so it is left untouched.
    expect(retitle(once, 'Thesis', 1, 'now write the conclusion')).toBe(once);
  });

  it('never clobbers a manual rename', () => {
    expect(retitle('My Forked Experiment', 'KTS', 3, 'do something')).toBe('My Forked Experiment');
  });
});
