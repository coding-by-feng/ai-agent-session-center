/**
 * DetachIcon — window-with-escaping-arrow glyph for every "pop out to a
 * native OS window" button. Shared here after being duplicated per-file:
 * DetailTabs.tsx (Project tab detach), SessionSwitcher.tsx (session detach,
 * 13x13 render), and now FloatingTerminalPanel.tsx (AI popup detach) would
 * have made three.
 *
 * Deliberately NOT a picture-in-picture glyph — a small box nested inside a
 * big box reads as an overlay that stays inside the app, the opposite of
 * what these buttons do. Window body + title-bar rule (reads as an OS
 * window, not a layout box) + arrow escaping the top-right corner.
 */
interface DetachIconProps {
  /** Render size in px. viewBox is a fixed 14x14 — this only scales the
   *  rendered element (a uniform scale of the artwork), matching how each
   *  consumer previously sized its own copy. */
  size?: number;
}

export default function DetachIcon({ size = 14 }: DetachIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="4.4" width="8.2" height="8.6" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <line x1="1" y1="6.9" x2="9.2" y2="6.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 6 L12.4 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8.9 1.6 H12.4 V5.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
