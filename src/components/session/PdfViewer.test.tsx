import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PdfViewer from './PdfViewer';
import { readPdfPosition, writePositionValue } from '@/lib/fileReadingPosition';

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (data?: unknown) => void>(),
  navigate: vi.fn(), destroy: vi.fn(), scroll: vi.fn(), currentPage: 3,
  location: { pageNumber: 3, left: 12, top: 610, rotation: 90 },
}));
vi.mock('@/lib/pdfAssets', () => ({ LocalCMapReader: class {}, LocalStandardFonts: class {} }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({}), destroy: mock.destroy }),
}));
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class { on(name: string, cb: (data?: unknown) => void) { mock.listeners.set(name, cb); } dispatch() {} },
  PDFLinkService: class { setViewer() {} setDocument() {} },
  PDFFindController: class {},
  PDFViewer: class {
    pagesCount = 10;
    currentScaleValue = '1.25';
    pagesRotation = 0;
    get currentPageNumber() { return mock.currentPage; }
    set currentPageNumber(value: number) { mock.currentPage = value; mock.navigate(value); }
    scrollPageIntoView = mock.scroll;
    setDocument(doc: unknown) { if (doc) { mock.listeners.get('pagesinit')?.(); mock.listeners.get('pagesloaded')?.(); } }
    update() { mock.listeners.get('updateviewarea')?.({ location: mock.location }); }
    cleanup() {}
  },
}));
beforeEach(() => {
  mock.listeners.clear(); mock.navigate.mockClear(); mock.destroy.mockClear(); mock.scroll.mockClear(); mock.currentPage = 3;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('restores a PDF anchor and does not reset its offset when the unchanged page field loses focus', async () => {
  writePositionValue('pdf-anchor-test', JSON.stringify({ page: 3, zoom: '1.25', left: 12, top: 610, rotation: 90 }));
  const view = render(<PdfViewer src="blob:fixture" name="fixture.pdf" positionKey="pdf-anchor-test" />);
  await waitFor(() => expect(view.getByLabelText('PDF page')).toHaveValue(3));
  expect(mock.scroll).toHaveBeenCalledWith({ pageNumber: 3, destArray: [null, { name: 'XYZ' }, 12, 610, null], allowNegativeOffset: true });
  fireEvent.focus(view.getByLabelText('PDF page'));
  fireEvent.blur(view.getByLabelText('PDF page'));
  expect(mock.navigate).not.toHaveBeenCalled();
  fireEvent.change(view.getByLabelText('PDF page'), { target: { value: '5' } });
  fireEvent.blur(view.getByLabelText('PDF page'));
  expect(mock.navigate).toHaveBeenCalledWith(5);
  view.unmount(); expect(mock.destroy).toHaveBeenCalledOnce();
});

it('does not overwrite the stored PDF anchor with hidden-view updates', async () => {
  const view = render(<PdfViewer src="blob:other" name="other.pdf" positionKey="pdf-hidden-test" />);
  await waitFor(() => expect(view.getByLabelText('PDF page')).toHaveValue(3));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const before = readPdfPosition('pdf-hidden-test');
  expect(before?.page).toBe(3);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0);
  act(() => { mock.listeners.get('updateviewarea')?.({ location: { pageNumber: 1, left: 0, top: 0, rotation: 0 } }); });
  view.unmount();
  expect(readPdfPosition('pdf-hidden-test')).toEqual(before);
});
