/**
 * icons — the session panel's glyph vocabulary, in one place (AASC-11).
 *
 * One meaning, one shape: before this file each component drew its own SVGs, so
 * "kill" was a skull in a room header and the word KILL in the control bar, and
 * a near-duplicate glyph could be minted anywhere. Rules for adding one:
 *
 * - Reuse before minting. A glyph that already means something here is not
 *   borrowed for something else (the skull is "kill", nothing else).
 * - Line art in `currentColor`, no emoji: a colour glyph beside stroked
 *   monochrome icons reads as a second design system.
 * - Decorative: every icon is `aria-hidden`. The button around it carries the
 *   name (IconButton's `label`, Button's text).
 * - The doc comment says what the glyph is NOT, when a neighbour is close.
 *
 * Sizes are each glyph's own (most 12–14px); IconButton overrides the box to its
 * size scale, so a glyph's width/height only matter outside it.
 */
import type { SVGProps } from 'react';
import FileTypeIcon from '@/components/ui/FileTypeIcon';

type IconProps = SVGProps<SVGSVGElement>;

const svg = (size: number, viewBox: string, props: IconProps) => ({
  width: size,
  height: size,
  viewBox,
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
  ...props,
});

// ---- Session title actions ------------------------------------------------------

/** Pencil — rename. Not the note page (remark) or the tag (label) beside it. */
export function EditIcon(props: IconProps) {
  return (
    <svg {...svg(13, '0 0 12 12', props)}>
      <path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Tag — the session's label. */
export function TagIcon(props: IconProps) {
  return (
    <svg {...svg(13, '0 0 12 12', props)}>
      <path d="M1.5 1.5h4l5 5-4 4-5-5v-4Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="3.6" cy="3.6" r="0.8" fill="currentColor" />
    </svg>
  );
}

/** A lined page — the progress remark. */
export function NoteIcon(props: IconProps) {
  return (
    <svg {...svg(13, '0 0 12 12', props)}>
      <path d="M2.5 1.5h7v9h-7v-9Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M4.2 4h3.6M4.2 6h3.6M4.2 8h2.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

/** Pin — session.pinned. `filled` when pinned: the state is in the glyph itself,
 *  so a pinned session reads as pinned, not as a selected tab. */
export function PinIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...svg(13, '0 0 12 12', props)}>
      <path
        d="M6 1.5c-1.5 0-2.6 1.1-2.6 2.5 0 1.1.7 2 1.7 2.4L6 10.5l0.9-4.1c1-.4 1.7-1.3 1.7-2.4 0-1.4-1.1-2.5-2.6-2.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill={filled ? 'currentColor' : 'none'}
      />
      <circle cx="6" cy="4" r="0.9" fill={filled ? 'var(--bg-card, #fff)' : 'currentColor'} />
    </svg>
  );
}

/** Skull — kill: one session (control row) or every session in a room. The one
 *  destructive glyph here, never reused for "close" or "remove". */
export function SkullIcon(props: IconProps) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      <path
        d="M8 1.6c-3 0-5 2-5 4.7 0 1.6.8 2.7 1.7 3.3v1.5c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9v-1.5c.9-.6 1.7-1.7 1.7-3.3 0-2.7-2-4.7-5-4.7Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="6.4" r="1.2" fill="currentColor" />
      <circle cx="10" cy="6.4" r="1.2" fill="currentColor" />
      <path d="M8 8.1l-.7 1.3h1.4L8 8.1Z" fill="currentColor" />
      <path d="M6.2 12v1.4M8 12v1.4M9.8 12v1.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

// ---- Session toggles (control row) ----------------------------------------------

/** Speaker with a slash — mute this session's sounds. */
export function MuteIcon(props: IconProps) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      <path d="M2.5 6h2.3L8 3.2v9.6L4.8 10H2.5V6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10.5 6l3.5 4M14 6l-3.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Broadcast arcs — share this session with your other devices. Not a link or
 *  an upload arrow: nothing leaves the dashboard; other devices may see it. */
export function ShareIcon(props: IconProps) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      <circle cx="8" cy="9" r="1.4" fill="currentColor" />
      <path d="M5.2 11.8a4 4 0 0 1 0-5.6M10.8 6.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 14a7 7 0 0 1 0-10M13 4a7 7 0 0 1 0 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Bell — loud alert sounds for approval and completion. */
export function AlertIcon(props: IconProps) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.5 14a1.6 1.6 0 0 0 3 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** No-entry sign — keep centrals' hands off this session. `filled` when it is on: the state is in the glyph itself
 *  (as the pin's is), so a protected session reads as protected, not as a selected tab. A ring with a bar while off,
 *  the same disc with the bar cut out of it while on. Not the skull (kill) or the speaker with a slash (mute): the
 *  session stays, it is only closed to steering. */
export function HandsOffIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      {filled ? (
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9ZM4.9 7.2a.8.8 0 0 0 0 1.6h6.2a.8.8 0 0 0 0-1.6H4.9Z"
        />
      ) : (
        <>
          <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.9 8h6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** Circular arrow — resume an ended session. Not the terminal's refresh. */
export function ResumeIcon(props: IconProps) {
  return (
    <svg {...svg(12, '0 0 16 16', props)}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 1.8v2.8H9.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Panel / view controls ---------------------------------------------------------

/** Sliders — the View menu (grouping, rooms shown, density, dock, maximize). */
export function ViewIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="4.5" cy="3.5" r="1.4" fill="var(--bg-card, #fff)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9.5" cy="7" r="1.4" fill="var(--bg-card, #fff)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="6" cy="10.5" r="1.4" fill="var(--bg-card, #fff)" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Down chevron — "this opens a list". Disclosure only; never "move down". */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...svg(10, '0 0 12 12', props)}>
      <polyline points="3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Tick — the checked item in a menu. */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...svg(10, '0 0 12 12', props)}>
      <polyline points="2.5,6.3 5,8.8 9.5,3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Funnel — a room filter is narrowing the list. */
export function RoomFilterIcon({ active = false, ...props }: IconProps & { active?: boolean }) {
  return (
    <svg {...svg(12, '0 0 12 12', props)}>
      <path
        d="M1 2h10L7 6.5V10.5L5 9.5V6.5L1 2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.3 : 0}
      />
    </svg>
  );
}

/** A room frame: a box with its name set into the top edge, one card inside. */
export function RoomViewIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path
        d="M5 2.4H3.4a1.9 1.9 0 0 0-1.9 1.9v6.3a1.9 1.9 0 0 0 1.9 1.9h7.2a1.9 1.9 0 0 0 1.9-1.9V4.3a1.9 1.9 0 0 0-1.9-1.9H9.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M6 2.4h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="4.2" y="6" width="5.6" height="3.6" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/** A room frame with a pin inside: the strip's built-in PINNED frame. Not
 *  PinIcon, which pins or unpins one session. */
export function PinnedFrameIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path
        d="M5 2.4H3.4a1.9 1.9 0 0 0-1.9 1.9v6.3a1.9 1.9 0 0 0 1.9 1.9h7.2a1.9 1.9 0 0 0 1.9-1.9V4.3a1.9 1.9 0 0 0-1.9-1.9H9.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M6 2.4h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M7 4.6c-.9 0-1.5.6-1.5 1.4 0 .6.4 1.1 1 1.4L7 10l.5-2.6c.6-.3 1-.8 1-1.4 0-.8-.6-1.4-1.5-1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** A folder: the project's directory (the file tree's own glyph). */
export function ProjectViewIcon() {
  return <FileTypeIcon name="project" isDir />;
}

/** Descending bars + down arrow — the flat "most recently active first" list. */
export function ActivityViewIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path d="M1 3.5H8M1 7H6M1 10.5H4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 2.5V11M9.2 9.2L11 11L12.8 9.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Two-column grid — the detailed card density. */
export function DetailedModeIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Two bars — the compact card density. */
export function CompactModeIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <rect x="1" y="2" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="9" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Panel with a left rail — the session bar docked on the left. */
export function DockLeftIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="1" width="4.5" height="12" rx="1.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** Panel with a top bar — the session bar docked on top. */
export function DockTopIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <rect x="1" y="1" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="1" width="12" height="4.5" rx="1.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** Expand to corners — hide the session list for more room. */
export function MaximizeIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path
        d="M2 5V2.5A.5.5 0 0 1 2.5 2H5M9 2h2.5a.5.5 0 0 1 .5.5V5M12 9v2.5a.5.5 0 0 1-.5.5H9M5 12H2.5a.5.5 0 0 1-.5-.5V9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Contract from corners — bring the session list back. */
export function RestoreSizeIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path
        d="M5 2v2.5a.5.5 0 0 1-.5.5H2M9 2v2.5a.5.5 0 0 0 .5.5H12M12 9H9.5a.5.5 0 0 0-.5.5V12M2 9h2.5a.5.5 0 0 1 .5.5V12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Double chevron left — fold the left rail to a thin strip. */
export function CollapseRailIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <polyline points="8 3 4 7 8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="11.5 3 7.5 7 11.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Double chevron right — unfold the collapsed rail. */
export function ExpandRailIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <polyline points="6 3 10 7 6 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="2.5 3 6.5 7 2.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Plus — start a new session. */
export function NewSessionIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A centred bar — minimize the session panel to its chip. Not "remove". Centred on
 *  y=7 like the rest of the rail header's glyphs (+, folder, «), or it sits low. */
export function MinimizeIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ---- Phone navigation (AASC-18) ------------------------------------------------------

/** Magnifier — search every session's prompts, replies and tool calls. */
export function SearchIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <circle cx="6" cy="6" r="3.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.9 8.9l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Two arrows chasing round — fetch the session list again (the phone's pull to
 *  refresh, as a button). Not ResumeIcon's single arrow (resume a session) or the
 *  terminal's replay. */
export function RefreshListIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <path d="M11.6 5.6A4.8 4.8 0 0 0 3 4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 1.9v2.6h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.4 8.4A4.8 4.8 0 0 0 11 9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 12.1V9.5H8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Three stacked cards — the phone's session drawer (the list of sessions).
 *  Not the queue badge's three bare lines. */
export function SessionListIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <rect x="2" y="2" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="6.5" width="10" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 12h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Single chevron left — the previous session in the list. Not the rail's double chevron. */
export function PrevSessionIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <polyline points="8.5 3 4.5 7 8.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Single chevron right — the next session in the list. */
export function NextSessionIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)}>
      <polyline points="5.5 3 9.5 7 5.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Three dots — more actions for one row (label, remark, fork, clone). */
export function MoreActionsIcon(props: IconProps) {
  return (
    <svg {...svg(14, '0 0 14 14', props)} fill="currentColor">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}

// ---- Session strip (room frames, cards) ----------------------------------------------

/** Six-dot grip — drag to reorder a room. Visual only; the hit box is the span. */
export function RoomDragHandleIcon(props: IconProps) {
  return (
    <svg {...svg(8, '0 0 8 12', props)} width={8} height={12} fill="currentColor">
      <circle cx="2" cy="2" r="1.1" />
      <circle cx="6" cy="2" r="1.1" />
      <circle cx="2" cy="6" r="1.1" />
      <circle cx="6" cy="6" r="1.1" />
      <circle cx="2" cy="10" r="1.1" />
      <circle cx="6" cy="10" r="1.1" />
    </svg>
  );
}

/** Up arrow WITH A SHAFT — move a room one slot earlier. The shaft is the point:
 *  a bare chevron is the collapse toggle's glyph family (disclosure), and two
 *  look-alike chevrons two slots apart did different things. */
export function MoveRoomUpIcon(props: IconProps) {
  return (
    <svg {...svg(10, '0 0 12 12', props)}>
      <path d="M6 10.2V2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <polyline points="2.7 5.7 6 2.4 9.3 5.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Down arrow WITH A SHAFT — move a room one slot later (see MoveRoomUpIcon). */
export function MoveRoomDownIcon(props: IconProps) {
  return (
    <svg {...svg(10, '0 0 12 12', props)}>
      <path d="M6 1.8V9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <polyline points="2.7 6.3 6 9.6 9.3 6.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Stacked list — a session has queued prompts (beside the count). */
export function QueueBadgeIcon(props: IconProps) {
  return (
    <svg {...svg(9, '0 0 24 24', props)} stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}
