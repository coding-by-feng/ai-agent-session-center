/**
 * StatusGlyph — a distinct icon per session status, so completed / approval /
 * input / working etc. are tellable apart at a glance, not by colour alone
 * (waiting and prompting even share cyan, and accent colours repeat across
 * themes). The glyph inherits its colour via `currentColor`.
 *
 * Shared by the session panel's rail (SessionSwitcher) and the LIVE board.
 * Decorative (`aria-hidden`): the status words next to it (the LIVE board), or
 * the rail badge's `role="img"` + `aria-label`, carry the meaning.
 *
 * The status→glyph mapping is backend-agnostic: status is derived identically
 * for Claude and Codex (same hook events → same status in sessionStore), so a
 * Codex session and a Claude session in the same real-world state show the
 * same icon.
 */

/** Shared SVG props for the stroked status glyphs — hoisted to module scope so
 *  it isn't re-allocated on every card render. */
const GLYPH_PROPS = {
  width: 10,
  height: 10,
  viewBox: '0 0 14 14',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export default function StatusGlyph({ status }: { status: string }) {
  switch (status) {
    case 'waiting': // completed — finished its turn, ready for review
      return <svg {...GLYPH_PROPS}><polyline points="3,7.4 6,10.2 11,4.2" /></svg>;
    case 'approval': // needs you to approve a tool — "!"
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="7" y1="2.8" x2="7" y2="8.4" />
          <circle cx="7" cy="11" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'input': // needs you to answer a question — "?"
      return (
        <svg {...GLYPH_PROPS}>
          <path d="M4.9 4.7a2.1 2.1 0 1 1 3.5 1.7c-.9.8-1.4 1.1-1.4 2.1" />
          <circle cx="7" cy="11" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'working': // tool running — spinner
      return (
        <svg {...GLYPH_PROPS}>
          <path d="M12 7a5 5 0 1 1-1.6-3.7" />
          <polyline points="11.9,1.7 11.9,4 9.6,4" />
        </svg>
      );
    case 'prompting': // prompt submitted — up arrow
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="7" y1="11.2" x2="7" y2="3.3" />
          <polyline points="3.9,6.4 7,3.3 10.1,6.4" />
        </svg>
      );
    case 'ended': // disconnected — ✕
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="3.9" y1="3.9" x2="10.1" y2="10.1" />
          <line x1="10.1" y1="3.9" x2="3.9" y2="10.1" />
        </svg>
      );
    case 'connecting': // handshaking — ellipsis
      return (
        <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
          <circle cx="3.3" cy="7" r="1.05" />
          <circle cx="7" cy="7" r="1.05" />
          <circle cx="10.7" cy="7" r="1.05" />
        </svg>
      );
    case 'idle': // available, doing nothing — pause bars
    default:
      return (
        <svg {...GLYPH_PROPS}>
          <line x1="5.2" y1="3.8" x2="5.2" y2="10.2" />
          <line x1="8.8" y1="3.8" x2="8.8" y2="10.2" />
        </svg>
      );
  }
}
