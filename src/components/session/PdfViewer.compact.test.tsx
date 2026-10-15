/**
 * PdfViewer's phone toolbar (`compact`, AASC-20 feature 48): one row of 44px
 * controls — the page, − Fit +, and Find, which opens its own row. Rotate,
 * Download and "Open original" (another window) are not offered on a phone;
 * the desktop toolbar keeps them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PdfViewer from './PdfViewer';

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (data?: unknown) => void>(),
  viewer: null as null | { currentScale: number; currentScaleValue: string; currentPageNumber: number },
  find: vi.fn(),
}));
vi.mock('@/lib/pdfAssets', () => ({ LocalCMapReader: class {}, LocalStandardFonts: class {} }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({}), destroy: vi.fn() }),
}));
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    on(name: string, cb: (data?: unknown) => void) { mock.listeners.set(name, cb); }
    dispatch(name: string, data: unknown) { if (name === 'find') mock.find(data); }
  },
  PDFLinkService: class { setViewer() {} setDocument() {} },
  PDFFindController: class {},
  PDFViewer: class {
    pagesCount = 4;
    currentScale = 1;
    currentScaleValue = 'page-width';
    currentPageNumber = 1;
    pagesRotation = 0;
    constructor() { mock.viewer = this; }
    scrollPageIntoView() {}
    setDocument(doc: unknown) { if (doc) mock.listeners.get('pagesinit')?.(); }
    update() {}
    cleanup() {}
  },
}));

beforeEach(() => {
  mock.listeners.clear();
  mock.find.mockClear();
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('gives a phone one row of page, zoom and find, and nothing that needs another window', async () => {
  render(<PdfViewer compact src="/api/files/stream?x" name="m.pdf" positionKey="pdf-compact-1" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled());
  const bar = screen.getByRole('toolbar', { name: 'PDF controls' });
  expect(bar).toContainElement(screen.getByLabelText('PDF page, of 4'));
  for (const name of ['Zoom out', 'Fit page width', 'Zoom in', 'Find in PDF']) {
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  }
  for (const gone of [/Rotate/, /Previous page/, /Next page/]) expect(screen.queryByRole('button', { name: gone })).toBeNull();
  expect(screen.queryByRole('link', { name: /Download|Open original/ })).toBeNull();
  expect(screen.queryByRole('search')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(mock.viewer!.currentScale).toBe(1.25);
  fireEvent.click(screen.getByRole('button', { name: 'Fit page width' }));
  expect(mock.viewer!.currentScaleValue).toBe('page-width');

  fireEvent.click(screen.getByRole('button', { name: 'Find in PDF' }));
  const search = screen.getByRole('search');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find in PDF' }), { target: { value: 'harness' } });
  await act(async () => { fireEvent.submit(search); });
  expect(mock.find).toHaveBeenCalledWith(expect.objectContaining({ query: 'harness' }));
});

it('keeps the desktop toolbar as it was', async () => {
  render(<PdfViewer src="blob:x" name="m.pdf" positionKey="pdf-compact-2" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument();
  expect(screen.queryByRole('toolbar', { name: 'PDF controls' })).toBeNull();
});
