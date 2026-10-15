/**
 * The phone project browser's pure rules (AASC-20): paths never climb out of
 * the project, the breadcrumb starts at the project's name, each file gets the
 * phone viewer it can use, a long file renders a window around its match, a
 * refused path reads as "not on this phone", and a pinch keeps the point under
 * the fingers.
 */
import { describe, it, expect } from 'vitest';
import {
  ancestorsOf,
  baseName,
  breadcrumbs,
  dragView,
  fileErrorText,
  joinRel,
  lineWindow,
  normalizeRel,
  parentRel,
  pinchView,
  relInProject,
  viewerKindFor,
  PHONE_LINE_WINDOW,
} from './phoneProject';

describe('paths', () => {
  it('normalizes, joins and climbs no higher than the project root', () => {
    expect(normalizeRel('')).toBe('/');
    expect(normalizeRel('src//lib/./a.ts')).toBe('/src/lib/a.ts');
    expect(normalizeRel('/../../etc/passwd')).toBe('/etc/passwd');
    expect(joinRel('/src', '../docs/x.md')).toBe('/docs/x.md');
    expect(parentRel('/src/lib/a.ts')).toBe('/src/lib');
    expect(parentRel('/')).toBe('/');
    expect(baseName('/src/lib/a.ts')).toBe('a.ts');
  });

  it('builds the folder stack and the breadcrumb from the project name down', () => {
    expect(ancestorsOf('/src/lib')).toEqual(['/', '/src', '/src/lib']);
    expect(breadcrumbs('/src/lib', 'agent-manager')).toEqual([
      { label: 'agent-manager', path: '/' },
      { label: 'src', path: '/src' },
      { label: 'lib', path: '/src/lib' },
    ]);
  });

  it('places a terminal file link inside the project, or nowhere', () => {
    expect(relInProject('src/a.ts', '/Users/me/proj')).toBe('/src/a.ts');
    expect(relInProject('/Users/me/proj/docs/x.md', '/Users/me/proj')).toBe('/docs/x.md');
    expect(relInProject('/Users/me/other/x.md', '/Users/me/proj')).toBeNull();
    expect(relInProject('/Users/me/project2/x.md', '/Users/me/proj')).toBeNull();
    expect(relInProject('~/.ssh/id_rsa', '/Users/me/proj')).toBeNull();
    expect(relInProject('  ', '/Users/me/proj')).toBeNull();
  });
});

describe('viewerKindFor', () => {
  it('gives each file the phone viewer it can use', () => {
    expect(viewerKindFor({ name: 'README.md', ext: 'md', content: '# x' })).toBe('markdown');
    expect(viewerKindFor({ name: 'paper.tex', ext: 'tex', content: '' })).toBe('tex');
    expect(viewerKindFor({ name: 'a.ts', ext: 'ts', content: 'x' })).toBe('text');
    expect(viewerKindFor({ name: 'Makefile', content: 'all:' })).toBe('text');
    expect(viewerKindFor({ name: 'm.pdf', ext: 'pdf', streamable: true })).toBe('pdf');
    expect(viewerKindFor({ name: 'h.PNG', ext: 'PNG', streamable: true })).toBe('image');
    expect(viewerKindFor({ name: 'v.mp4', ext: 'mp4', streamable: true })).toBe('media');
    expect(viewerKindFor({ name: 's.docx', ext: 'docx', streamable: true })).toBe('none');
    expect(viewerKindFor({ name: 'b.bin', binary: true })).toBe('none');
  });
});

describe('lineWindow', () => {
  it('renders a short file whole', () => {
    expect(lineWindow(120, 88)).toEqual({ start: 0, end: 120 });
  });

  it('renders a window holding the target near its top, inside the file', () => {
    const w = lineWindow(50_000, 30_000);
    expect(w.end - w.start).toBe(PHONE_LINE_WINDOW);
    expect(w.start).toBeLessThan(30_000);
    expect(w.end).toBeGreaterThan(30_000);
    expect(30_000 - w.start).toBeLessThan(PHONE_LINE_WINDOW / 4);
    expect(lineWindow(50_000, 49_999)).toEqual({ start: 48_000, end: 50_000 });
    expect(lineWindow(50_000, null)).toEqual({ start: 0, end: PHONE_LINE_WINDOW });
  });
});

describe('fileErrorText', () => {
  it('says a refused (404) path is not available on this phone, without telling refused from missing', () => {
    const text = fileErrorText(404, 'file');
    expect(text.title).toBe("This file isn't available on this phone");
    expect(text.hint).toMatch(/shared session/);
    expect(text.hint).toMatch(/moved or deleted/);
    expect(fileErrorText(0, 'folder').title).toMatch(/could not be reached/);
    expect(fileErrorText(500, 'folder').title).toMatch(/could not be opened/);
  });
});

describe('pinch and drag', () => {
  const stage = { width: 400, height: 600 };

  it('scales with the fingers, never below fit, keeping the point under the midpoint', () => {
    const start = { view: { zoom: 1, panX: 0, panY: 0 }, distance: 100, mid: { x: 300, y: 300 } };
    const view = pinchView(start, { distance: 200, mid: { x: 300, y: 300 } }, stage);
    expect(view.zoom).toBe(2);
    // The point under (300,300) — 100px right of centre — stays there: pan = 100 - 100*2.
    expect(view.panX).toBe(-100);
    expect(view.panY).toBe(0);
    expect(pinchView(start, { distance: 20, mid: { x: 300, y: 300 } }, stage).zoom).toBe(1);
  });

  it('drags a zoomed picture only as far as it can go', () => {
    const zoomed = { zoom: 2, panX: 0, panY: 0 };
    expect(dragView(zoomed, 50, -30, stage)).toEqual({ zoom: 2, panX: 50, panY: -30 });
    expect(dragView(zoomed, 5000, 0, stage).panX).toBe(200);
    expect(dragView({ zoom: 1, panX: 0, panY: 0 }, 50, 50, stage)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});
