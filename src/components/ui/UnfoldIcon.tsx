/**
 * UnfoldIcon — "show the rest of this" / "show less" for a block of text that
 * is cut off. Two chevrons around a dashed centre line: pointing AWAY from the
 * line to unfold, TOWARD it to fold back.
 *
 * Deliberately not a plain chevron or triangle. In the prompt queue it sits
 * beside the ▲ ▼ reorder buttons, and a `⌄` there reads as "move down"; the
 * panel header's own collapse control is a filled disclosure triangle
 * (`FrameCollapseIcon`'s family). A stroked "chevrons around a line" shape is
 * neither, and says "this region grows".
 */
interface UnfoldIconProps {
  /** True when the text is already unfolded, so the icon offers to fold it. */
  expanded: boolean;
  /** Render size in px. The viewBox is a fixed 12x12. */
  size?: number;
}

export default function UnfoldIcon({ expanded, size = 12 }: UnfoldIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M1.2 6h1.8M5.1 6h1.8M9 6h1.8" />
      {expanded ? (
        <>
          <path d="M3.6 1.4 6 3.8l2.4-2.4" />
          <path d="M3.6 10.6 6 8.2l2.4 2.4" />
        </>
      ) : (
        <>
          <path d="M3.6 3.8 6 1.4l2.4 2.4" />
          <path d="M3.6 8.2 6 10.6l2.4-2.4" />
        </>
      )}
    </svg>
  );
}
