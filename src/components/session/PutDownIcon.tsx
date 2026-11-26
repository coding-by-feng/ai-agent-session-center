/**
 * RECENT's Put down glyph (Nov 23 2026): an eye with a slash, "hide it" (Nov 24: was an arrow onto a line, which
 * read as download; a moon would read as the ASLEEP status). Drawn by the desktop card's control, RECENT's header
 * chip and the phone's Recent group (Nov 24 2026). No stylesheet import, so the phone chunk doesn't pull in the
 * desktop's DetailPanel CSS. Decorative; the control is named.
 */
export function PutDownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M1.2 6s1.8-3.4 4.8-3.4S10.8 6 10.8 6 9 9.4 6 9.4 1.2 6 1.2 6Z" />
      <circle cx="6" cy="6" r="1.4" />
      <path d="M1.8 10.6 10.2 1.4" />
    </svg>
  );
}
