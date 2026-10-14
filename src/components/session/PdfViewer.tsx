import { useEffect, useRef, useState } from 'react';
import type { PDFViewer as Viewer } from 'pdfjs-dist/types/web/pdf_viewer';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import NativeSelect from '@/components/ui/NativeSelect';
import { readPdfPosition, writePositionValue, type PdfPosition } from '@/lib/fileReadingPosition';
import { LocalCMapReader, LocalStandardFonts } from '@/lib/pdfAssets';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import styles from '@/styles/modules/PdfViewer.module.css';

export default function PdfViewer({
  src,
  name,
  positionKey,
}: {
  src: string;
  name: string;
  positionKey: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const findRef = useRef<((query: string, previous?: boolean) => void) | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState('');
  const [count, setCount] = useState(0);
  const [page, setPage] = useState('1');
  const [zoom, setZoom] = useState('page-width');
  const [error, setError] = useState('');
  useEffect(() => {
    const el = container.current;
    const pageEl = pages.current;
    if (!el || !pageEl) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      const { PDFViewer, PDFLinkService, EventBus, PDFFindController } =
        await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const eventBus = new EventBus();
      const linkService = new PDFLinkService({
        eventBus,
        externalLinkTarget: 2,
        externalLinkRel: 'noopener noreferrer',
      });
      const findController = new PDFFindController({ eventBus, linkService });
      findRef.current = (query, previous = false) =>
        eventBus.dispatch('find', {
          source: el,
          type: 'again',
          query,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          findPrevious: previous,
          matchDiacritics: false,
        });
      eventBus.on(
        'updatefindmatchescount',
        ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
          if (!disposed) setMatches(`${matchesCount.current} / ${matchesCount.total}`);
        },
      );
      eventBus.on('updatefindcontrolstate', ({ state }: { state: number }) => {
        if (!disposed && state === 1) setMatches('No matches');
      });
      const lifetime = new AbortController();
      // PDF.js 4.8 supports abortSignal at runtime but omits it from its published type.
      const viewerOptions = {
        abortSignal: lifetime.signal,
        container: el,
        viewer: pageEl,
        eventBus,
        linkService,
        findController,
      };
      const viewer = new PDFViewer(viewerOptions);
      viewerRef.current = viewer;
      linkService.setViewer(viewer);
      const task = pdfjs.getDocument({
        url: src,
        isEvalSupported: false,
        useWorkerFetch: false,
        CMapReaderFactory: LocalCMapReader,
        StandardFontDataFactory: LocalStandardFonts,
      });
      let initialized = false;
      let restoring = false;
      let last: PdfPosition | null = readPdfPosition(positionKey);
      let frame = 0;
      let wasVisible = false;
      const restore = () => {
        if (!initialized || !el.clientHeight) {
          wasVisible = false;
          return;
        }
        if (wasVisible) return;
        wasVisible = true;
        restoring = true;
        const saved = readPdfPosition(positionKey) ?? last;
        viewer.pagesRotation = saved?.rotation ?? 0;
        viewer.currentScaleValue = saved?.zoom ?? 'page-width';
        if (saved)
          viewer.scrollPageIntoView({
            pageNumber: Math.min(saved.page, viewer.pagesCount),
            destArray: [null, { name: 'XYZ' }, saved.left, saved.top, null],
            allowNegativeOffset: true,
          });
        setZoom(viewer.currentScaleValue);
        setPage(String(viewer.currentPageNumber));
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          restoring = false;
          viewer.update();
        });
      };
      eventBus.on(
        'updateviewarea',
        ({
          location,
        }: {
          location: { pageNumber: number; left: number; top: number; rotation: number };
        }) => {
          if (!initialized || restoring || !el.clientHeight || disposed) return;
          last = {
            page: location.pageNumber,
            left: location.left,
            top: location.top,
            rotation: location.rotation,
            zoom: viewer.currentScaleValue,
          };
          writePositionValue(positionKey, JSON.stringify(last));
          setPage(String(viewer.currentPageNumber));
          setZoom(viewer.currentScaleValue);
        },
      );
      eventBus.on('pagesinit', () => {
        initialized = true;
        setCount(viewer.pagesCount);
        restore();
      });
      // Refresh visible pages once document loading completes.
      eventBus.on('pagesloaded', () => {
        if (!initialized) return;
        viewer.update();
      });
      const observer = new ResizeObserver(() => {
        if (!el.clientHeight) {
          wasVisible = false;
          return;
        }
        restore();
        viewer.update();
      });
      observer.observe(el);
      const persist = () => {
        if (initialized && el.clientHeight && !restoring) viewer.update();
      };
      window.addEventListener('pagehide', persist);
      destroy = () => {
        persist();
        observer.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('pagehide', persist);
        viewerRef.current = null;
        findRef.current = null;
        lifetime.abort();
        viewer.setDocument(null!);
        viewer.cleanup();
        void task.destroy();
        pageEl.replaceChildren();
      };
      const document = await task.promise;
      if (disposed) return;
      linkService.setDocument(document);
      viewer.setDocument(document);
    })().catch((e) => {
      if (!disposed) setError(e instanceof Error ? e.message : 'Could not open PDF');
    });
    return () => {
      destroy?.();
      disposed = true;
    };
  }, [src, positionKey]);
  return (
    <section className={styles.root} aria-label={`PDF: ${name}`}>
      <div className={styles.toolbar} aria-label="PDF controls">
        <Button
          size="sm"
          aria-label="Previous page"
          disabled={!count || Number(page) <= 1}
          onClick={() => {
            if (viewerRef.current) viewerRef.current.currentPageNumber--;
          }}
        >
          Previous
        </Button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = viewerRef.current;
            if (v) {
              v.currentPageNumber = Math.max(1, Math.min(count, Math.trunc(Number(page)) || 1));
              setPage(String(v.currentPageNumber));
            }
          }}
        >
          <TextInput
            className={styles.pageInput}
            type="number"
            min={1}
            max={count || 1}
            aria-label="PDF page"
            value={page}
            onChange={(e) => setPage(e.target.value)}
            onBlur={() => {
              const v = viewerRef.current;
              if (v) {
                const target = Math.max(1, Math.min(count, Math.trunc(Number(page)) || 1));
                if (target !== v.currentPageNumber) v.currentPageNumber = target;
                setPage(String(v.currentPageNumber));
              }
            }}
          />
        </form>
        <span>/ {count || '…'}</span>
        <Button
          size="sm"
          aria-label="Next page"
          disabled={!count || Number(page) >= count}
          onClick={() => {
            if (viewerRef.current) viewerRef.current.currentPageNumber++;
          }}
        >
          Next
        </Button>
        <NativeSelect
          aria-label="PDF zoom"
          value={zoom}
          disabled={!count}
          onChange={(value) => {
            if (viewerRef.current) viewerRef.current.currentScaleValue = value;
          }}
          options={[
            { value: 'page-width', label: 'Fit width' },
            { value: 'page-fit', label: 'Fit page' },
            ...['0.5', '0.75', '1', '1.25', '1.5', '2', '3'].map((value) => ({
              value,
              label: `${Number(value) * 100}%`,
            })),
            ...(!['page-width', 'page-fit', '0.5', '0.75', '1', '1.25', '1.5', '2', '3'].includes(
              zoom,
            )
              ? [{ value: zoom, label: `${Math.round(Number(zoom) * 100)}%` }]
              : []),
          ]}
        />
        <Button
          size="sm"
          disabled={!count}
          onClick={() => {
            const v = viewerRef.current;
            if (v) v.pagesRotation = (v.pagesRotation + 90) % 360;
          }}
        >
          Rotate
        </Button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            findRef.current?.(query);
          }}
        >
          <TextInput
            aria-label="Find in PDF"
            placeholder="Find in PDF"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatches('');
            }}
          />
        </form>
        <Button size="sm" disabled={!count || !query} onClick={() => findRef.current?.(query)}>
          Find next
        </Button>
        <span role="status">{matches}</span>
        <a href={src} download={name}>
          Download
        </a>
        <a href={src} target="_blank" rel="noopener noreferrer">
          Open original / print
        </a>
      </div>
      {error ? (
        <div role="alert" className={styles.status}>
          {error}
        </div>
      ) : (
        !count && (
          <div role="status" className={styles.status}>
            Loading PDF…
          </div>
        )
      )}
      <div className={styles.frame}>
        <div ref={container} className={styles.scroller} tabIndex={0} aria-label="PDF pages">
          <div ref={pages} className="pdfViewer" />
        </div>
      </div>
    </section>
  );
}
