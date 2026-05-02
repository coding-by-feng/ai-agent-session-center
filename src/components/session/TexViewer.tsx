import { useEffect, useRef, useState } from 'react';
import styles from '@/styles/modules/TexViewer.module.css';

interface TexViewerProps {
  source: string;
  /** Stable key (typically file path) so we can recompute when the doc changes. */
  fileKey?: string;
}

type LatexParse = (
  src: string,
  opts: { generator: unknown },
) => { domFragment(): DocumentFragment };

type LatexJsModule = {
  parse?: LatexParse;
  HtmlGenerator?: new (opts?: Record<string, unknown>) => unknown;
  default?: {
    parse?: LatexParse;
    HtmlGenerator?: new (opts?: Record<string, unknown>) => unknown;
  };
};

/**
 * Commands latex.js doesn't implement — we drop them (with their { } and [ ] args)
 * before re-parsing so a thesis-grade document at least produces text + structure.
 * This is intentionally broad: precision is bounded by what the engine supports.
 */
const UNSUPPORTED_CMDS = [
  // Page / layout
  'pagenumbering', 'pagestyle', 'thispagestyle', 'cleardoublepage', 'clearpage',
  'newpage', 'pagebreak', 'nopagebreak', 'enlargethispage', 'flushbottom', 'raggedbottom',
  'geometry', 'hypersetup',
  // Counters & lengths
  'setcounter', 'addtocounter', 'stepcounter', 'refstepcounter',
  'setlength', 'addtolength', 'settowidth', 'settoheight', 'settodepth',
  'newcounter', 'newlength', 'numberwithin', 'arabic', 'roman', 'Roman', 'alph', 'Alph',
  // Macro / environment definitions (the bodies aren't expanded by latex.js anyway)
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand',
  'newenvironment', 'renewenvironment',
  'newtheorem', 'theoremstyle',
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  // Title / section formatting
  'titleformat', 'titlespacing', 'titlecontents', 'dottedcontents',
  // Fonts
  'fontfamily', 'fontseries', 'fontshape', 'fontsize', 'selectfont',
  'usefont', 'setmainfont', 'setsansfont', 'setmonofont', 'setmathfont',
  'newfontfamily', 'newfontface',
  // Hooks
  'AtBeginDocument', 'AtEndDocument', 'AtBeginEnvironment', 'AtEndEnvironment',
  // Misc preamble-style noise
  'definecolor', 'colorlet', 'lstset', 'lstdefinestyle',
  'usetikzlibrary', 'tikzset', 'pgfplotsset',
  'captionsetup', 'DeclareCaptionFormat', 'DeclareCaptionLabelFormat',
  'graphicspath', 'addbibresource', 'bibliographystyle', 'bibliography',
  'frontmatter', 'mainmatter', 'backmatter',
];

/**
 * Strip preamble + un-resolvable directives so latex.js can render thesis-style
 * documents whose `\documentclass`/`\usepackage` lines aren't supported.
 * Returns the body wrapped in a minimal article scaffold.
 */
function buildFallbackSource(source: string): string {
  const bodyMatch = source.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  let body = bodyMatch ? bodyMatch[1] : source;

  // We have no file resolver in the browser, so external includes can't render.
  body = body.replace(/\\(input|include|subfile|import|subimport)\s*\{[^}]*\}/g, (m) => `% [unresolved: ${m}]`);
  // Drop \cite arguments to plain text so they don't break the parser.
  body = body.replace(/\\cite[a-zA-Z]*\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g, '[$2]');
  // Drop unsupported commands together with up to 4 brace args + leading optional args.
  // Note: braces are matched non-greedily without nesting support — sufficient for
  // typical thesis preamble syntax (\hypersetup{...}, \titleformat{\section}{}{}{}, etc.).
  for (const cmd of UNSUPPORTED_CMDS) {
    const re = new RegExp(`\\\\${cmd}\\b(?:\\s*\\[[^\\]]*\\])*(?:\\s*\\{[^{}]*\\}){0,4}`, 'g');
    body = body.replace(re, '');
  }
  // Strip starred form noise like \section* → \section (latex.js tolerates non-starred).
  body = body.replace(/\\(section|subsection|subsubsection|chapter|paragraph|subparagraph)\*/g, '\\$1');

  return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

/**
 * Renders LaTeX source to HTML using latex.js (pure-JS, MIT).
 * Covers a useful subset of LaTeX (sectioning, math, lists, tables, figures).
 * On parse failure we retry with a stripped preamble + minimal article scaffold,
 * which salvages most thesis-style documents at the cost of dropping custom macros.
 */
export default function TexViewer({ source, fileKey }: TexViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWarning(null);
    host.replaceChildren();

    (async () => {
      try {
        // Lazy-load latex.js — the bundle is large (~5MB minified).
        const mod = (await import('latex.js')) as LatexJsModule;
        if (cancelled) return;
        const parse = mod.parse ?? mod.default?.parse;
        const HtmlGenerator = mod.HtmlGenerator ?? mod.default?.HtmlGenerator;
        if (!parse || !HtmlGenerator) {
          throw new Error('latex.js exports not found');
        }

        const tryParse = (src: string): DocumentFragment => {
          const generator = new HtmlGenerator({ hyphenate: false });
          return parse(src, { generator }).domFragment();
        };

        let fragment: DocumentFragment;
        let usedFallback = false;
        try {
          fragment = tryParse(source);
        } catch (firstErr) {
          // Retry with stripped preamble — handles unsupported \documentclass,
          // custom packages, \input{...}, bibliography commands, etc.
          const fallbackSrc = buildFallbackSource(source);
          if (fallbackSrc === source) throw firstErr;
          fragment = tryParse(fallbackSrc);
          usedFallback = true;
        }
        if (cancelled) return;

        host.replaceChildren(fragment);
        if (usedFallback) {
          setWarning(
            'Rendered with a minimal article preamble — custom packages, macros, and external includes were dropped.',
          );
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, fileKey]);

  return (
    <div className={styles.wrapper}>
      {loading && <div className={styles.status}>Rendering LaTeX…</div>}
      {error && (
        <div className={styles.error}>
          <div className={styles.errorTitle}>LaTeX render error</div>
          <pre className={styles.errorBody}>{error}</pre>
          <div className={styles.errorHint}>
            Switch to Source view (toolbar TₑX button) to inspect the document.
          </div>
        </div>
      )}
      {warning && !error && <div className={styles.warning}>{warning}</div>}
      <div ref={hostRef} className={styles.paper} />
    </div>
  );
}
