/**
 * Glyphs for the phone's composer, waiting cards and terminal key bar
 * (AASC-42/43/45). The kit's 24px grid and stroke, drawn in currentColor,
 * decorative: whatever wears one names itself in words.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ children, size = 22, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;

export const SendIcon = (p: IconProps) => <Svg strokeWidth="2.2" {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;


export const SlashIcon = (p: IconProps) => <Svg {...p}><path d="M15 4L9 20" /></Svg>;

export const AtIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3.6" /><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7" /></Svg>
);

export const PhotoIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-7 8" /></Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><circle cx="12" cy="12.5" r="3.4" /></Svg>
);

export const SnippetIcon = (p: IconProps) => <Svg {...p}><path d="M7 4h10v16l-5-3.5L7 20z" /></Svg>;

export const FileIcon = (p: IconProps) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" /></Svg>
);

export const QueueIcon = (p: IconProps) => (
  <Svg size={18} {...p}><rect x="4" y="4" width="12" height="12" rx="2" /><path d="M8 20h10a2 2 0 0 0 2-2V8" /></Svg>
);

export const TerminalIcon = (p: IconProps) => (
  <Svg size={20} {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7 10l3 2.5L7 15M12.5 15H17" /></Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>
);

export const CommandsIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7 9.5h4M7 13h10M7 16.5h6" /></Svg>
);

export const SearchIcon = (p: IconProps) => <Svg size={18} {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></Svg>;

export const ArrowKey = ({ direction, ...p }: IconProps & { direction: 'up' | 'down' | 'left' | 'right' }) => {
  const rotate = { up: 0, right: 90, down: 180, left: 270 }[direction];
  return <Svg size={18} strokeWidth="2.2" {...p}><g transform={`rotate(${rotate} 12 12)`}><path d="M12 19V5M6.5 10.5L12 5l5.5 5.5" /></g></Svg>;
};

export const EnterKeyIcon = (p: IconProps) => <Svg size={18} strokeWidth="2.2" {...p}><path d="M19 5v7a3 3 0 0 1-3 3H6" /><path d="M10 11l-4 4 4 4" /></Svg>;

export const FullscreenIcon = (p: IconProps) => (
  <Svg size={20} {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>
);

export const WarningIcon = (p: IconProps) => (
  <Svg size={18} {...p}><path d="M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4.5" /><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" /></Svg>
);

export const QuestionIcon = (p: IconProps) => (
  <Svg size={18} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8" /><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" /></Svg>
);

export const ContinueIcon = (p: IconProps) => (
  <Svg size={18} {...p}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><polyline points="20 4 20 8 16 8" /></Svg>
);

export const DoneIcon = (p: IconProps) => (
  <Svg size={18} {...p}><circle cx="12" cy="12" r="9" /><polyline points="8 12.5 11 15.5 16.5 9.5" /></Svg>
);

/** The context-window ring: how full, at a glance (the % is always written beside it). */
export function ContextRing({ pct, size = 16 }: { pct: number; size?: number }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="2.2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeDasharray={`${c * filled} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
