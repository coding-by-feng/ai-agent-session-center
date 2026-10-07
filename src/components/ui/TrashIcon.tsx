/**
 * TrashIcon — "delete / remove this row". One shape for the destructive row
 * action on every view tab (an AGENDA task, a QUEUE item, a HISTORY session),
 * so the verb reads the same everywhere; pair it with
 * `<IconButton tone="danger">`. Not for "clear the field" (that is a ✕).
 */
interface TrashIconProps {
  /** Render size in px; IconButton re-sizes it to its own glyph size. */
  size?: number;
}

export default function TrashIcon({ size = 14 }: TrashIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
