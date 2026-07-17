/**
 * PopupResponse — shared display for a captured AI-popup / REVIEW response.
 *
 * The raw capture is a best-effort snapshot of a Claude Code TUI screen, so it
 * can carry shell command-echo, heredoc prompts and CLI banner chrome around
 * the real answer. This component cleans that noise (`formatPopupResponse`,
 * non-destructive) and renders the result as themed markdown — headings, bold,
 * lists and tables — instead of raw monospace text. A raw ⇆ formatted toggle
 * always exposes the exact capture, and copy grabs whatever is on screen.
 *
 * Used by AiPopupHistory (AI POPUPS tab) and ReviewView (REVIEW history) so the
 * cleaning + rendering logic lives in one place.
 */
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatPopupResponse } from '@/lib/popupResponse';
import styles from '@/styles/modules/PopupResponse.module.css';

interface PopupResponseProps {
  /** Raw captured response as stored in IndexedDB. */
  response: string;
  /** Section label (AI POPUPS uses "Response", REVIEW uses "Conversation"). */
  label?: string;
  /** Message shown when nothing was captured. */
  emptyHint?: string;
}

const DEFAULT_EMPTY_HINT =
  '(response not captured — close the floating session to capture it)';

// Open links in a new tab; react-markdown (no rehype-raw) already blocks raw
// HTML and sanitizes javascript: URLs, so this is purely a target/rel tweak.
const MD_COMPONENTS = {
  a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function PopupResponse({
  response,
  label = 'Response',
  emptyHint = DEFAULT_EMPTY_HINT,
}: PopupResponseProps) {
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasRaw = response.trim().length > 0;
  const formatted = useMemo(() => formatPopupResponse(response), [response]);
  const hasFormatted = formatted.length > 0;

  // Fall back to raw whenever there is nothing readable to format.
  const showRaw = rawMode || !hasFormatted;
  const shownText = showRaw ? response : formatted;

  const handleCopy = () => {
    navigator.clipboard
      ?.writeText(shownText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* ignore */
      });
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>
        <span>{label}</span>
        {hasRaw && (
          <div className={styles.tools}>
            {hasFormatted && (
              <button
                type="button"
                className={styles.toolBtn}
                aria-pressed={showRaw}
                title={showRaw ? 'Show formatted answer' : 'Show raw terminal capture'}
                onClick={() => setRawMode((v) => !v)}
              >
                {showRaw ? 'formatted' : 'raw'}
              </button>
            )}
            <button type="button" className={styles.toolBtn} onClick={handleCopy}>
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        )}
      </div>

      {!hasRaw ? (
        <div className={styles.empty}>{emptyHint}</div>
      ) : showRaw ? (
        <>
          {!hasFormatted && (
            <div className={styles.rawNote}>
              No readable answer in this capture — showing the raw terminal output.
            </div>
          )}
          <pre className={styles.raw}>{response}</pre>
        </>
      ) : (
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {formatted}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
